import { inflateSync, deflateSync } from 'node:zlib'
import { sha1, objectId } from './objects.ts'

const kinds = ['', 'commit','tree','blob','tag']
const limit = 48 * 1024 * 1024

function applyDelta(base, patch) {
  let pos = 0
  function byte() {
    if (pos >= patch.length) throw Error('Truncated delta')
    return patch[pos++]
  }
  function integer() {
    let value = 0, factor = 1
    while (factor <= 2 ** 35) {
      const n = byte()
      value += (n & 127) * factor
      if (!(n & 128)) return value
      factor *= 128
    }
    throw Error('Invalid delta size')
  }
  if (integer() !== base.length) throw Error('Bad delta base size')
  const size = integer()
  if (size > limit) throw Error('Object too large')
  const out = Buffer.allocUnsafe(size)
  let written = 0
  while (pos < patch.length) {
    const op = byte()
    if (op & 128) {
      let offset = 0, count = 0
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 256 ** i
      for (let i = 0; i < 3; i++) if (op & (16 << i)) count += byte() * 256 ** i
      count ||= 65536
      if (offset + count > base.length || written + count > size) throw Error('Invalid delta copy')
      base.copy(out,written,offset,offset+count)
      written += count
    } else {
      if (!op || pos + op > patch.length || written + op > size) throw Error('Invalid delta insert')
      patch.copy(out,written,pos,pos+op)
      written += op
      pos += op
    }
  }
  if (written !== size) throw Error('Incomplete delta')
  return out
}

export function unpack(repo, pack) {
  if (!pack.length) return
  if (pack.length < 32 || pack.toString('ascii',0,4) !== 'PACK' || ![2,3].includes(pack.readUInt32BE(4))) throw Error('Invalid pack header')
  const end = pack.length - 20
  if (!sha1(pack.subarray(0,end)).equals(pack.subarray(end))) throw Error('Pack checksum mismatch')
  const count = pack.readUInt32BE(8)
  const offsets = new Map(), pending = [], fresh = new Map()
  let pos = 12, total = 0
  function byte() {
    if (pos >= end) throw Error('Truncated pack')
    return pack[pos++]
  }
  function record(start,type,data,compressed) {
    total += data.length
    if (total > 160 * 1024 * 1024) throw Error('Pack too large')
    const obj = {type,data,compressed}
    fresh.set(objectId(type,data),obj)
    offsets.set(start,obj)
  }
  for (let i = 0; i < count; i++) {
    const start = pos
    let n = byte(), size = n & 15, factor = 16
    const kind = (n >> 4) & 7
    while (n & 128) {
      n = byte()
      size += (n & 127) * factor
      factor *= 128
      if (factor > 2 ** 40 || size > limit) throw Error('Object too large')
    }
    let base
    if (kind === 6) {
      n = byte()
      let offset = n & 127
      while (n & 128) {
        n = byte()
        offset = (offset + 1) * 128 + (n & 127)
        if (offset > start) throw Error('Invalid delta offset')
      }
      base = start - offset
    } else if (kind === 7) {
      base = pack.toString('hex',pos,pos+20)
      pos += 20
    } else if (!kinds[kind]) throw Error('Invalid pack object type')
    const from = pos
    const result = inflateSync(pack.subarray(pos,end),{info:true,maxOutputLength:Math.max(1,size)})
    pos += result.engine.bytesWritten
    if (result.buffer.length !== size) throw Error('Invalid packed size')
    if (base === undefined) record(start,kinds[kind],result.buffer,pack.subarray(from,pos))
    else pending.push({start,base,data:result.buffer})
  }
  if (pos !== end) throw Error('Trailing pack data')
  let todo = pending
  while (todo.length) {
    const next = []
    for (const item of todo) {
      const base = offsets.get(item.base) || fresh.get(item.base) || repo.objects.get(item.base)
      if (base) record(item.start,base.type,applyDelta(base.data,item.data),null)
      else next.push(item)
    }
    if (next.length === todo.length) throw Error('Missing delta base')
    todo = next
  }
  for (const [id,obj] of fresh) if (!repo.objects.has(id)) repo.objects.set(id,obj)
}

export function encodePack(objects) {
  const header = Buffer.alloc(12)
  header.write('PACK')
  header.writeUInt32BE(2,4)
  header.writeUInt32BE(objects.length,8)
  const parts = [header]
  for (const obj of objects) {
    let size = obj.data.length
    const bytes = [(kinds.indexOf(obj.type) << 4) | (size & 15)]
    size = Math.floor(size / 16)
    while (size) {
      bytes[bytes.length-1] |= 128
      bytes.push(size & 127)
      size = Math.floor(size / 128)
    }
    obj.compressed ??= deflateSync(obj.data,{level:1})
    parts.push(Buffer.from(bytes),obj.compressed)
  }
  const content = Buffer.concat(parts)
  return Buffer.concat([content,sha1(content)])
}
