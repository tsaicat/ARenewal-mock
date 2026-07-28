// lib/ids.js — small dependency-free id generator (avoids pulling in uuid).

function randomSegment(len = 8) {
  return Array.from({ length: len }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
  ).join("");
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomSegment()}`;
}
