/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../logger.js';
import {zod, ajv, type JSONSchema7, type ElementHandle} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  execute: (input: any) => any;
}

export interface ToolGroup {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

declare global {
  interface Window {
    __mcp_tool_group?: ToolGroup;
    __mcp_stashed_elements?: HTMLElement[];
  }
}

export const listInPageTools = defineTool({
  name: 'list_in_page_tools',
  description: `Lists all in-page-tools the page exposes for providing runtime information.
  In-page-tools can be called via the 'execute_in_page_tool()' MCP tool.
  In addition, the in-page-tools are exposed on the page via the 'window.__mcp_tool_group.tools' array
  where they can be called by 'evaluate_script'. This might be helpful when the in-page-tools return
  non-serializable values or when composing the in-page-tools with additional functionality.`,
  annotations: {
    category: ToolCategory.IN_PAGE,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, _context) => {
    response.setListInPageTools();
  },
});

export const executeInPageTool = defineTool({
  name: 'execute_in_page_tool',
  description: `Executes a tool exposed by the page.`,
  annotations: {
    category: ToolCategory.IN_PAGE,
    readOnlyHint: false,
  },
  schema: {
    toolName: zod.string().describe('The name of the tool to execute'),
    params: zod.record(zod.string(), zod.unknown()).optional().describe('The parameters to pass to the tool'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const toolName = request.params.toolName;
    const params = request.params.params ?? {};

    // Creates array of ElementHandles from the uids in the params.
    // We do not replace the uids with the ElementsHandles yet, because
    // the `evaluate` function only turns them into DOM elements if they
    // are passed as non-nested arguments.
    const handles: ElementHandle[] = [];
    for (const value of Object.values(params)) {
      if (value instanceof Object && 'uid' in value && typeof value.uid === 'string') {
        handles.push(await context.getElementByUid(value.uid));
      }
    }

    // Get tools from context
    const toolGroup = context.getInPageTools();
    // Alternatively: get tools from page
    // const toolGroup = await getToolGroup(page);
    // context.setInPageTools(toolGroup);
    const tool = toolGroup?.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }
    const ajvInstance = new ajv();
    const validate = ajvInstance.compile(tool.inputSchema);
    const valid = validate(params);
    if (!valid) {
      throw new Error(`Invalid parameters for tool ${toolName}: ${ajvInstance.errorsText(validate.errors)}`);
    }

    const result = await page.evaluate(async (name, args, ...elements) => {
      // Replace the uids with DOM elements.
      for (const [key, value] of Object.entries(args)) {
        if (value instanceof Object && 'uid' in value && typeof value.uid === 'string') {
          args[key] = elements.shift();
        }
      } 

      if (!window.__mcp_tool_group) {
        throw new Error('No tools found on the page');
      }
      const tool = window.__mcp_tool_group.tools.find(t => t.name === name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }
      const toolResult = await tool.execute(args);
      console.log('toolResult', toolResult);

      const stashDOMElement = (el: HTMLElement) => {
        if (window.__mcp_stashed_elements === undefined) {
          window.__mcp_stashed_elements = [];
        }
        window.__mcp_stashed_elements.push(el);
        return {uid: `stashed-${window.__mcp_stashed_elements.length - 1}`};
      };

      // Walks the tool result and replaces all DOM elements with uids.
      const stashAllDOMElements = (data: any) => {
        // 1. Handle DOM Elements
        if (data instanceof HTMLElement) {
          return stashDOMElement(data);
        }

        // 2. Handle Arrays
        if (Array.isArray(data)) {
          return data.map((item: any): any => stashAllDOMElements(item));
        }

        // 3. Handle Objects
        if (data !== null && typeof data === 'object') {
          const processedObj: {
            [key: string]: number | string,
          } = {};
          for (const [key, value] of Object.entries(data)) {
            processedObj[key] = stashAllDOMElements(value);
          }
          return processedObj;
        }

        // 4. Return primitives (strings, numbers, booleans) as-is
        return data;
      };
      const resultWithStashedElements = stashAllDOMElements(toolResult);
      console.log('resultWithStashedElements', resultWithStashedElements);
      return {result: resultWithStashedElements, stashed: window.__mcp_stashed_elements?.length};
    }, toolName, params, ...handles);

    const elementHandles: ElementHandle[] = [];
    for (let i = 0; i < (result.stashed ?? 0); i++) {
      const elementHandle = await page.evaluateHandle((index) => {
        return window.__mcp_stashed_elements?.[index];
      }, i);
      logger('elementHandle', elementHandle);
      elementHandles.push(elementHandle as ElementHandle);
    }
    const resultWithStashedElements = result.result;

    const stashedToUid = async (index: number) => {
      const backendNodeId = await elementHandles[index].backendNodeId();
      if (!backendNodeId) {
        logger(`Could not get backendNodeId for element ${index}`);
        return {uid: `stashed-${index}`};
      }
      let cdpElementId = context.resolveCdpElementId(backendNodeId); 
      if (!cdpElementId) {
        await context.createTextSnapshot(false, undefined, page, elementHandles);
        cdpElementId = context.resolveCdpElementId(backendNodeId);
      }
      if (!cdpElementId) {
        logger(`Could not get cdpElementId for backend node ${backendNodeId}`);
        return {uid: `stashed-${index}`};
      }
      return {uid: cdpElementId};
    };

    const walkTree = async (node: any): Promise<any> => {
      if (Array.isArray(node)) {
        return await Promise.all(node.map(async x => await walkTree(x)));
      }
      if (node !== null && typeof node === 'object') {
        if (node.uid && node.uid.startsWith('stashed-')) {
          const index = parseInt(node.uid.split('-')[1]);
          return stashedToUid(index);
        }
        for (const [key, value] of Object.entries(node)) {
          node[key] = await walkTree(value);
        }
      }
      return node;
    };

    const resultWithUids = await walkTree(resultWithStashedElements);
    response.appendResponseLine(typeof resultWithUids === 'string' ? resultWithUids : JSON.stringify(resultWithUids, null, 2));
    response.includeSnapshot({page});
  },
});