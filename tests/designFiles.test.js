import assert from "node:assert/strict";
import test from "node:test";
import { validateDesignFile } from "../src/designFiles.js";

const fixtures = [
  ["design.jpg", "image/jpeg", [0xff, 0xd8, 0xff, 0xd9]],
  ["design.jpeg", "image/jpeg", [0xff, 0xd8, 0xff, 0xd9]],
  ["design.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["design.webp", "image/webp", [...Buffer.from("RIFF0000WEBP")]],
  ["design.bmp", "image/bmp", [...Buffer.from("BM000000")]],
  ["design.gif", "image/gif", [...Buffer.from("GIF89a")]],
  ["design.tiff", "image/tiff", [0x49, 0x49, 0x2a, 0x00]],
  ["design.tif", "image/tiff", [0x4d, 0x4d, 0x00, 0x2a]],
  ["design.svg", "image/svg+xml", [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')]],
  ["design.eps", "application/postscript", [...Buffer.from("%!PS-Adobe-3.0 EPSF-3.0")]],
  ["design.ai", "application/postscript", [...Buffer.from("%!PS-Adobe-3.0")]],
  ["design.cdr", "application/vnd.corel-draw", [...Buffer.from("RIFF0000CDR9")]],
  ["design.pdf", "application/pdf", [...Buffer.from("%PDF-1.7")]],
  ["design.psd", "image/vnd.adobe.photoshop", [0x38, 0x42, 0x50, 0x53, 0x00, 0x01]],
  ["design.psb", "image/vnd.adobe.photoshop", [0x38, 0x42, 0x50, 0x53, 0x00, 0x02]],
  ["design.dxf", "image/vnd.dxf", [...Buffer.from("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n")]],
  ["design.dwg", "image/vnd.dwg", [...Buffer.from("AC1027")]],
  ["design.zip", "application/zip", [0x50, 0x4b, 0x03, 0x04]],
  ["design.rar", "application/vnd.rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
];

function makeFile(name, type, bytes) {
  const file = new Blob([Uint8Array.from(bytes)], { type });
  Object.defineProperty(file, "name", { value: name });
  return file;
}

test("validates every supported extension against MIME type and file signature", async () => {
  for (const [name, type, bytes] of fixtures) {
    const result = await validateDesignFile(makeFile(name, type, bytes));
    assert.equal(result.contentType, type, name);
  }
});

test("rejects mismatched MIME types and spoofed file extensions", async () => {
  await assert.rejects(validateDesignFile(makeFile("design.pdf", "image/png", [0x25, 0x50, 0x44, 0x46, 0x2d])));
  await assert.rejects(validateDesignFile(makeFile("design.exe", "application/octet-stream", [0x4d, 0x5a])));
});

test("rejects active SVG content", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await assert.rejects(validateDesignFile(makeFile("design.svg", "image/svg+xml", [...Buffer.from(svg)])));
});