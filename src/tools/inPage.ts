/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Page, zod, ajv, type JSONSchema7} from '../third_party/index.js';

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
  }
}

export const listInPageTools = defineTool({
  name: 'list_in_page_tools',
  description: `Lists all tools the page exposes for providing runtime information.`,
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

    const result = await page.evaluate(async (name, args) => {
      if (!window.__mcp_tool_group) {
        throw new Error('No tools found on the page');
      }
      const tool = window.__mcp_tool_group.tools.find(t => t.name === name);
      if (tool) {
        return await tool.execute(args);
      }
      throw new Error(`Tool ${name} not found`);
    }, toolName, params);
    response.appendResponseLine(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  },
});