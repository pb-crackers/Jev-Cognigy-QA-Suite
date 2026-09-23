/**
 * The few DOM and fetch helpers both front-end modules share.
 */
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export const $ = (id) => document.getElementById(id);
export const usd = (n) => `$${n < 0.01 ? n.toFixed(6) : n.toFixed(2)}`;
export const json = async (url, options) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};
