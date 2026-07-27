/**
 * Shared confirm gate used by executor.js, documents.js, and any future tool.
 * Kept in its own module to avoid circular dependencies.
 *
 * autoRunTools     – skip ALL confirmations (including dangerous terminal)
 * autoApproveSafe  – skip confirmations for file ops + safe commands;
 *                    dangerous terminal commands still call ctx.confirm directly
 */

/**
 * @param {object} ctx
 * @param {string} message
 * @returns {Promise<boolean>}
 */
async function maybeConfirm(ctx, message) {
  if (ctx.cfg?.autoRunTools) return true;
  if (ctx.cfg?.autoApproveSafe) return true;
  if (typeof ctx.confirm === "function") return ctx.confirm(message);
  return true;
}

module.exports = { maybeConfirm };
