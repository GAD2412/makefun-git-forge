import { encodePack, unpack } from './pack.ts'
import { links, isAncestor } from './objects.ts'

const ZERO = '0'.repeat(40)
const flush = Buffer.from('0000'), delim = Buffer.from('0001')
function pkt(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4,'0')),body])
}
const v2Advert = Buffer.concat(['version 2','agent=makefun-forge/1','ls-refs=unborn','fetch=shallow','object-format=sha1'].map(x => pkt(x+'\n')).concat(flush))
function packets(data, stop) {
  let pos = 0
  const lines = []
  while (pos < data.length) {
    const hex = data.toString('ascii',pos,pos+4)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw Error('Invalid packet length')
    const n = Number.parseInt(hex,16)
    pos += 4
    if (n < 3) {
      if (!n && stop) break
      continue
    }
    if (n < 4 || pos+n-4 > data.length) throw Error('Incomplete packet')
    lines.push(data.toString('utf8',pos,pos+n-4).replace(/\n$/,''))
    pos += n-4
  }
  return {lines,tail:data.subarray(pos)}
}
function sideband(buffer) {
  const parts = []
  for (let i=0;i<buffer.length;i+=65515) parts.push(pkt(Buffer.concat([Buffer.from([1]),buffer.subarray(i,i+65515)])))
  return parts
}
function peeled(repo,id) {
  let obj = repo.objects.get(id)
  while (obj?.type === 'tag') {
    id = links(obj)[0]
    obj = repo.objects.get(id)
  }
  return id
}
function advertise(repo,service,v2) {
  if (v2 && service === 'git-upload-pack') return v2Advert
  const receive = service === 'git-receive-pack'
  const head = 'refs/heads/'+repo.info.default_branch
  const capabilities = receive ? 'report-status delete-refs side-band-64k ofs-delta' : 'multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:'+head
  const lines = []
  if (!receive && repo.refs.has(head)) lines.push(repo.refs.get(head)+' HEAD')
  for (const [ref,id] of repo.refs) {
    lines.push(id+' '+ref)
    if (!receive && repo.objects.get(id)?.type === 'tag') lines.push(peeled(repo,id)+' '+ref+'^{}')
  }
  if (!lines.length) lines.push(ZERO+' capabilities^{}')
  lines[0] += '\0'+capabilities
  return Buffer.concat([pkt('# service='+service+'\n'),flush,...lines.map(l=>pkt(l+'\n')),flush])
}
function receive(repo,body) {
  const {lines,tail} = packets(body,true)
  const commands = lines.filter(x => !x.startsWith('shallow '))
  const caps = commands[0]?.split('\0')[1]?.split(' ') || []
  const report = []
  let unpackError = ''
  try { unpack(repo,tail) } catch(e) { unpackError = e.message }
  report.push(pkt('unpack '+(unpackError || 'ok')+'\n'))
  for (const cmd of commands) {
    const [old,id,ref] = cmd.split('\0')[0].split(' ')
    if (!/^refs\/(?:heads|tags)\/[^\s~^:?*[\]\\]+$/.test(ref || '') || ref.includes('..') || ref.includes('@{') || !/^[0-9a-f]{40}$/.test(id)) throw Error('Invalid ref command')
    const current = repo.refs.get(ref) || ZERO
    let error = unpackError
    if (!error && current !== old) error = 'stale info'
    if (!error && id !== ZERO && !repo.objects.has(id)) error = 'missing object'
    if (!error && id !== ZERO && old !== ZERO && !isAncestor(repo,old,id)) error = 'non-fast-forward'
    if (!error) {
      if (id === ZERO) repo.refs.delete(ref)
      else repo.refs.set(ref,id)
    }
    report.push(pkt((error ? 'ng '+ref+' '+error : 'ok '+ref)+'\n'))
  }
  report.push(flush)
  const inner = Buffer.concat(report)
  return caps.includes('side-band-64k') ? Buffer.concat([...sideband(inner),flush]) : inner
}
function listRefs(repo,lines) {
  const prefixes = lines.filter(x=>x.startsWith('ref-prefix ')).map(x=>x.slice(11))
  const matches = ref => !prefixes.length || prefixes.some(prefix=>ref.startsWith(prefix))
  const head = 'refs/heads/'+repo.info.default_branch
  const out = []
  if (matches('HEAD') && (repo.refs.has(head) || lines.includes('unborn'))) {
    const sym = lines.includes('symrefs') ? ' symref-target:'+head : ''
    out.push(pkt((repo.refs.get(head) || 'unborn')+' HEAD'+sym+'\n'))
  }
  for (const [name,id] of repo.refs) if (matches(name)) {
    const target = lines.includes('peel') && repo.objects.get(id)?.type === 'tag' ? ' peeled:'+peeled(repo,id) : ''
    out.push(pkt(id+' '+name+target+'\n'))
  }
  return Buffer.concat([...out,flush])
}

// Walk commits breadth first so that multiple wants respect the shortest depth to each ancestor.
function closure(repo, roots, depth, clientBoundary = new Set()) {
  const seen = new Set(), boundary = new Set(), queue = roots.map(id=>[id,1])
  for (let i=0;i<queue.length;i++) {
    const [id,level] = queue[i]
    if (seen.has(id)) continue
    const obj = repo.objects.get(id)
    if (!obj) continue
    seen.add(id)
    const children = links(obj)
    if (obj.type !== 'commit') {
      for (const child of children) queue.push([child,level])
      continue
    }
    if (children[0]) queue.push([children[0],level])
    if (children.length > 1 && level >= depth) boundary.add(id)
    else if (!clientBoundary.has(id)) for (const parent of children.slice(1)) queue.push([parent,level+1])
  }
  return {seen,boundary}
}
function fetchPack(repo,lines,v2) {
  const values = key => lines.filter(l=>l.startsWith(key+' ')).map(l=>l.split(' ')[1])
  const wants = values('want'), haves = values('have'), shallow = new Set(values('shallow'))
  const depth = Number(values('deepen')[0]) || Infinity
  const cacheKey = JSON.stringify([wants,depth,v2])
  if (!haves.length && !shallow.size && repo.fetchCache?.key === cacheKey) return repo.fetchCache.bytes
  if (wants.some(id=>!repo.objects.has(id))) throw Error('Unknown want')
  if (!lines.includes('done') && haves.length && v2) {
    const found = haves.filter(id=>repo.objects.has(id))
    return Buffer.concat([pkt('acknowledgments\n'),...(found.length ? found.map(id=>pkt('ACK '+id+'\n')) : [pkt('NAK\n')]),flush])
  }
  let reach = closure(repo,wants,depth)
  if (shallow.size && lines.includes('deepen-relative')) {
    const past = closure(repo,[...shallow],depth+1)
    const present = closure(repo,wants,Infinity,shallow)
    reach = {seen:new Set([...past.seen,...present.seen]),boundary:past.boundary}
  }
  const known = closure(repo,haves,Infinity,shallow).seen
  const send = []
  for (const id of reach.seen) if (!known.has(id)) send.push(repo.objects.get(id))
  const prefix = []
  if (v2 && Number.isFinite(depth)) {
    prefix.push(pkt('shallow-info\n'))
    for (const id of reach.boundary) if (!shallow.has(id)) prefix.push(pkt('shallow '+id+'\n'))
    for (const id of shallow) if (reach.seen.has(id) && !reach.boundary.has(id)) prefix.push(pkt('unshallow '+id+'\n'))
    prefix.push(delim)
  }
  prefix.push(pkt(v2 ? 'packfile\n' : 'NAK\n'))
  const bytes = Buffer.concat([...prefix,...sideband(encodePack(send)),flush])
  if (!haves.length && !shallow.size && bytes.length <= 2*1024*1024) repo.fetchCache = {key:cacheKey,bytes}
  return bytes
}
export function gitRequest(repo,service,discovery,v2,body) {
  if (!['git-upload-pack','git-receive-pack'].includes(service)) throw Error('Unknown Git service')
  if (discovery) return advertise(repo,service,v2)
  if (service === 'git-receive-pack') return receive(repo,body)
  const {lines} = packets(body,false)
  if (lines.includes('command=ls-refs')) return listRefs(repo,lines)
  return fetchPack(repo,lines,v2 || lines.includes('command=fetch'))
}
