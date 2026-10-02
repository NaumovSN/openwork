import assert from "node:assert/strict"
import { test } from "node:test"
import { buildZip, utf8Bytes } from "@openwork/workbook"
import { FILE_LIMITS, normalizePath, runFileTool } from "../src/files.js"
import { formatToolResult, modelToolName } from "../src/mcp.js"
import { Store } from "../src/store.js"

test("paths cannot escape the session workspace", () => {
  assert.equal(normalizePath("notes/./a.md"), "notes/a.md")
  assert.equal(normalizePath("/abs/path.md"), "abs/path.md")
  assert.equal(normalizePath("../etc/passwd"), null)
  assert.equal(normalizePath("a/../../b"), null)
  assert.equal(normalizePath(""), null)
  assert.equal(normalizePath("bad\u0000name"), null)
})

test("files are isolated per session and quota-limited", () => {
  const store = new Store(":memory:")
  const a = store.createSession({})
  const b = store.createSession({})
  assert.equal(runFileTool(store, a.id, "write_file", { path: "x.md", content: "hello" }).isError, false)
  assert.equal(runFileTool(store, b.id, "read_file", { path: "x.md" }).isError, true)
  assert.equal(runFileTool(store, a.id, "edit_file", { path: "x.md", find: "hello", replace: "bye" }).isError, false)
  assert.equal(runFileTool(store, a.id, "read_file", { path: "x.md" }).output, "bye")
  const big = "x".repeat(FILE_LIMITS.maxFileBytes + 1)
  assert.equal(runFileTool(store, a.id, "write_file", { path: "big.txt", content: big }).isError, true)
  assert.equal(runFileTool(store, a.id, "write_file", { path: 7 }).isError, true)
  assert.equal(runFileTool(store, a.id, "delete_file", { path: "x.md" }).isError, false)
  assert.equal(runFileTool(store, a.id, "list_files", {}).output, "The workspace is empty.")
})

test("MCP tool names are provider-safe and never shadow built-in tools", () => {
  assert.equal(modelToolName("slack.search messages", new Set()), "slack_search_messages")
  assert.equal(modelToolName("write_file", new Set(["write_file"])), "mcp_write_file")
})

test("MCP results are flattened to bounded text", async () => {
  assert.deepEqual(await formatToolResult({ content: [{ type: "text", text: "a" }, { type: "image", data: "AAAA" }] }), {
    output: "a\n[Can't open file (unknown type, 3 bytes) here. Ask for a PDF, text, or image version.]",
    isError: false,
  })
  assert.deepEqual(await formatToolResult({ content: [], structuredContent: { n: 1 }, isError: true }), { output: "{\"n\":1}", isError: true })
  assert.ok((await formatToolResult({ content: [{ type: "text", text: "z".repeat(60_000) }] })).output.includes("[truncated"))
})

test("MCP images become model input, within supported types and limits", async () => {
  const png = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }
  const result = await formatToolResult({
    content: [
      { type: "text", text: "file.png (59 KB)" },
      png,
      { type: "resource", resource: { uri: "slack://F1", blob: "R0lGOD=", mimeType: "image/gif" } },
      { type: "image", data: "AAAA", mimeType: "image/tiff" },
    ],
  })
  assert.deepEqual(result.images, [
    { mediaType: "image/png", data: "iVBORw0KGgo=" },
    { mediaType: "image/gif", data: "R0lGOD=" },
  ])
  assert.equal(
    result.output,
    "file.png (59 KB)\n[image 1: image/png, attached]\n[image 2: image/gif, attached]\n[Can't open file (image/tiff, 3 bytes) here. Ask for a PNG or JPEG version.]",
  )
  const many = await formatToolResult({ content: Array.from({ length: 6 }, () => png) })
  assert.equal(many.images?.length, 4)
  const huge = await formatToolResult({ content: [{ type: "image", data: "x".repeat(5_000_001), mimeType: "image/png" }] })
  assert.equal(huge.images, undefined)
  assert.ok(huge.output.includes("too large"))
})

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
const resource = (uri: string, mimeType: string, blob: string) => ({ type: "resource", resource: { uri, mimeType, blob } })

test("a PDF a tool returns becomes model input; one that is too large becomes a clear note", async () => {
  const pdf = base64("%PDF-1.7 tiny")
  const result = await formatToolResult({
    content: [{ type: "text", text: "Files: brief.pdf (application/pdf)" }, resource("slack://file/F1/brief.pdf", "application/pdf", pdf)],
  })
  assert.deepEqual(result.documents, [{ mediaType: "application/pdf", data: pdf, name: "brief.pdf" }])
  assert.match(result.output, /\[PDF brief\.pdf \(13 bytes\), attached\]$/)

  const untyped = await formatToolResult({ content: [resource("https://files.example/report.pdf", "application/octet-stream", pdf)] })
  assert.equal(untyped.documents?.length, 1, "the extension identifies a PDF sent without a type")

  const huge = await formatToolResult({ content: [resource("slack://file/F2/deck.pdf", "application/pdf", "A".repeat(14_000_004))] })
  assert.equal(huge.documents, undefined)
  assert.match(huge.output, /^\[Can't open deck\.pdf \(PDF, 10\.0 MB\) here: it is larger than 10 MB\./)
})

test("Office files a tool returns are read as text with the shared extractor", async () => {
  const docx = Buffer.from(
    await buildZip([{ name: "word/document.xml", data: utf8Bytes("<w:document><w:body><w:t>Launch moves to Tuesday.</w:t></w:body></w:document>") }]),
  ).toString("base64")
  const result = await formatToolResult({
    content: [resource("slack://file/F3/plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx)],
  })
  assert.equal(result.documents, undefined)
  assert.match(result.output, /^\[Word document plan\.docx, extracted text\]\n/)
  assert.ok(result.output.includes("Launch moves to Tuesday."))

  const broken = await formatToolResult({ content: [resource("slack://file/F4/bad.xlsx", "application/octet-stream", base64("not a zip"))] })
  assert.match(broken.output, /^\[Couldn't read bad\.xlsx \(Excel workbook\): /)
})

test("text files are decoded, linked and embedded text resources are shown, and everything else gets a plain note", async () => {
  const result = await formatToolResult({
    content: [
      resource("slack://file/F5/numbers.csv", "text/csv", base64("region,revenue\nEMEA,1742")),
      resource("slack://file/F6/config.yaml", "", base64("retries: 3")),
      { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# Notes" } },
      { type: "resource_link", uri: "https://drive.example/d/1", name: "Roadmap", mimeType: "application/pdf" },
      resource("slack://file/F7/standup.mov", "video/quicktime", "AAAA"),
      resource("slack://file/F8/export.zip", "application/zip", "AAAA"),
      resource("slack://file/F9/legacy.doc", "application/msword", "AAAA"),
      { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
    ],
  })
  assert.equal(
    result.output,
    [
      "[numbers.csv]\nregion,revenue\nEMEA,1742",
      "[config.yaml]\nretries: 3",
      "[notes.md]\n# Notes",
      "[Linked file: Roadmap (application/pdf) https://drive.example/d/1]",
      "[Can't open standup.mov (video, 3 bytes) here. Audio and video can't be read; ask for a transcript or screenshots.]",
      "[Can't open export.zip (archive, 3 bytes) here. Ask for the specific files inside it.]",
      "[Can't open legacy.doc (application/msword, 3 bytes) here. Ask for a PDF, .docx, .xlsx, or .pptx version.]",
      "[Can't open file (audio, 3 bytes) here. Audio and video can't be read; ask for a transcript or screenshots.]",
    ].join("\n"),
  )
  assert.equal(result.images, undefined)
  assert.equal(result.documents, undefined)
})
