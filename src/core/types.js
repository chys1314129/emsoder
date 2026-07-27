/** @typedef {'openai'|'anthropic'} ProviderType */

/**
 * @typedef {Object} ModelProvider
 * @property {string} id
 * @property {string} name
 * @property {ProviderType} type
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string[]} models
 * @property {boolean} enabled
 * @property {Record<string,string>} [headers]
 * @property {string} [chatPath]
 */

/**
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content
 * @property {string} [name]
 * @property {string} [tool_call_id]
 * @property {ToolCall[]} [tool_calls]
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{name:string, arguments:string}} function
 */

/**
 * @typedef {Object} StreamChunk
 * @property {'text'|'tool_call'|'done'|'error'|'reasoning'} type
 * @property {string} [text]
 * @property {any} [toolCall]
 * @property {string} [error]
 */

module.exports = {};
