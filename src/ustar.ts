import { gzipSync } from "node:zlib";

const BLOCK = 512;
const USTAR_NAME = 100;
const USTAR_PREFIX = 155;

export type UstarFile = {
  name: string;
  content: Buffer;
};

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const digits = length - 1;
  const body = value.toString(8).padStart(digits, "0");
  if (body.length > digits) {
    throw new Error(`octal field overflow: ${value} needs more than ${digits} digits`);
  }
  buf.write(body, offset, digits, "ascii");
  buf[offset + digits] = 0;
}

function writeBytes(buf: Buffer, offset: number, max: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > max) {
    throw new Error(`ustar field too long (${bytes.length} > ${max})`);
  }
  bytes.copy(buf, offset);
}

function paxRecord(keyword: string, value: string): Buffer {
  const suffix = ` ${keyword}=${value}\n`;
  let len = Buffer.byteLength(`${suffix.length}${suffix}`, "utf8");
  for (let i = 0; i < 8; i += 1) {
    const rec = `${len}${suffix}`;
    const actual = Buffer.byteLength(rec, "utf8");
    if (actual === len) return Buffer.from(rec, "utf8");
    len = actual;
  }
  throw new Error("pax record length did not converge");
}

function padToBlock(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}

function splitUstarName(posixPath: string): { name: string; prefix: string } | null {
  const pathBytes = Buffer.byteLength(posixPath, "utf8");
  if (pathBytes <= USTAR_NAME) return { name: posixPath, prefix: "" };
  const parts = posixPath.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (
      Buffer.byteLength(prefix, "utf8") <= USTAR_PREFIX &&
      Buffer.byteLength(name, "utf8") <= USTAR_NAME
    ) {
      return { name, prefix };
    }
  }
  return null;
}

function ustarHeader(opts: {
  name: string;
  prefix: string;
  size: number;
  typeflag: string;
  mode: number;
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeBytes(header, 0, USTAR_NAME, opts.name);
  writeOctal(header, 100, 8, opts.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, opts.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(opts.typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeBytes(header, 345, USTAR_PREFIX, opts.prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i]!;
  const chk = `${sum.toString(8).padStart(6, "0")}\0 `;
  header.write(chk, 148, 8, "ascii");
  return header;
}

function shortNameForPax(posixPath: string, index: number): string {
  const base = posixPath.split("/").pop() || "file";
  if (Buffer.byteLength(base, "utf8") <= USTAR_NAME) return base;
  return `file-${index}`;
}

function fileBlocks(file: UstarFile, index: number): Buffer[] {
  const chunks: Buffer[] = [];
  const split = splitUstarName(file.name);
  let name: string;
  let prefix: string;
  if (split) {
    name = split.name;
    prefix = split.prefix;
  } else {
    const pax = paxRecord("path", file.name);
    const paxName = `PaxHeader/${index}`;
    chunks.push(
      ustarHeader({
        name: paxName,
        prefix: "",
        size: pax.length,
        typeflag: "x",
        // Regular files and PAX headers are 0644. No directory / 0755 entries.
        mode: 0o644,
      }),
      padToBlock(pax)
    );
    name = shortNameForPax(file.name, index);
    prefix = "";
  }
  chunks.push(
    ustarHeader({
      name,
      prefix,
      size: file.content.length,
      typeflag: "0",
      mode: 0o644, // files only; no 0755 / directory entries
    }),
    padToBlock(file.content)
  );
  return chunks;
}

export function createUstar(files: readonly UstarFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks: Buffer[] = [];
  sorted.forEach((file, index) => {
    chunks.push(...fileBlocks(file, index));
  });
  chunks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(chunks);
}

/** gzipSync with mtime 0 and OS=255 so the bytes match on every platform. */
export function gzipDeterministic(data: Buffer): Buffer {
  const gz = gzipSync(data, { level: 6 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 255;
  return gz;
}
