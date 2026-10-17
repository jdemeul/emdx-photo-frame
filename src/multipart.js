// A forgiving multipart/form-data reader for what the display POSTs (its thumbnails).
// Node's built-in parser (undici) rejects bodies with small irregularities, such as bare
// LF line breaks or a missing closing boundary; Samsung's own app (Ktor) accepts them.
// Returns [{ name, filename, type, content (Buffer) }].
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw new Error(`no multipart boundary in content type "${contentType || ''}"`);
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // "--": the closing boundary
    if (body[pos] === 0x0d) pos++;
    if (body[pos] === 0x0a) pos++;
    const next = body.indexOf(boundary, pos);
    let part = body.subarray(pos, next === -1 ? body.length : next);
    if (part[part.length - 1] === 0x0a) part = part.subarray(0, -1); // the line break before the boundary
    if (part[part.length - 1] === 0x0d) part = part.subarray(0, -1);
    let sep = part.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (sep === -1) { sep = part.indexOf('\n\n'); sepLen = 2; }
    if (sep !== -1) {
      const headers = part.subarray(0, sep).toString('utf8');
      const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] || '';
      parts.push({
        name: /(?:^|;)\s*name="?([^";]*)"?/i.exec(disposition)?.[1] ?? null,
        filename: /filename\*?="?([^";]*)"?/i.exec(disposition)?.[1] ?? null,
        type: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? null,
        content: part.subarray(sep + sepLen),
      });
    }
    pos = next;
  }
  if (!parts.length) throw new Error('no parts found in the multipart body');
  return parts;
}
