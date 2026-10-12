/** Validate tool inputs before dispatch. JSON-schema subset used by local tools;
 * unknown schema keywords remain the executor/MCP server's responsibility. */
function validateArguments(value, schema, path = "arguments") {
  if (schema === false) throw new Error(`${path}: schema rejects this value`);
  if (!schema || schema === true) return;
  const fail = (message) => { throw new Error(`${path}: ${message}`); };
  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    let valid = 0;
    for (const branch of branches) { try { validateArguments(value, branch, path); valid++; } catch { /* try next */ } }
    if (!valid || (schema.oneOf && valid !== 1)) fail("does not match schema alternatives");
  }
  if (schema.allOf) for (const branch of schema.allOf) validateArguments(value, branch, path);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) fail("not in enum");
  if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) fail("does not match const");
  const matches = (type) => {
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "null") return value === null;
    return typeof value === type;
  };
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) fail(`expected ${schema.type}`);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing required ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateArguments(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateArguments(item, schema.additionalProperties, `${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) fail("too few items");
    if (schema.maxItems != null && value.length > schema.maxItems) fail("too many items");
    if (schema.items) value.forEach((item, index) => validateArguments(item, schema.items, `${path}[${index}]`));
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) fail("string too short");
    if (schema.maxLength != null && value.length > schema.maxLength) fail("string too long");
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) fail("below minimum");
    if (schema.maximum != null && value > schema.maximum) fail("above maximum");
  }
}
module.exports = { validateArguments };
