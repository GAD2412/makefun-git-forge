import { createHash } from 'node:crypto'

export function sha1(bytes) {
  return createHash('sha1').update(bytes).digest()
}

export function objectId(type, data) {
  return createHash('sha1').update(type + ' ' + data.length + '\0').update(data).digest('hex')
}

export function save(repo, type, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const id = objectId(type, bytes)
  if (!repo.objects.has(id)) repo.objects.set(id, {type, data:bytes})
  return id
}

export function treeEntries(object) {
  if (object.entries) return object.entries
  const entries = []
  let pos = 0
  while (pos < object.data.length) {
    const space = object.data.indexOf(32, pos)
    const end = object.data.indexOf(0, space + 1)
    if (space <= pos || end <= space || end + 21 > object.data.length) throw Error('Invalid Git tree')
    entries.push({mode:object.data.toString('ascii',pos,space), name:object.data.toString('utf8',space+1,end), sha:object.data.toString('hex',end+1,end+21)})
    pos = end + 21
  }
  return object.entries = entries
}

export function links(object) {
  if (object.links) return object.links
  let children = []
  if (object.type === 'tree') children = treeEntries(object).filter(e => e.mode !== '160000').map(e => e.sha)
  if (object.type === 'commit' || object.type === 'tag') {
    const header = object.data.toString('utf8').split('\n\n',1)[0]
    for (const line of header.split('\n')) {
      if (/^(tree|parent|object) [0-9a-f]{40}$/.test(line)) children.push(line.slice(line.indexOf(' ') + 1))
    }
  }
  return object.links = children
}

export function ancestors(repo, tip) {
  const seen = new Set()
  const stack = [tip]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    const obj = repo.objects.get(id)
    if (obj?.type !== 'commit') continue
    seen.add(id)
    stack.push(...links(obj).slice(1))
  }
  return seen
}

export function isAncestor(repo, old, tip) {
  if (tip === old) return true
  const obj = repo.objects.get(tip)
  if (obj?.type !== 'commit') return false
  if (links(obj).slice(1).includes(old)) return true
  return ancestors(repo,tip).has(old)
}

export function filesAt(repo, commit) {
  const files = new Map()
  const root = repo.objects.get(commit)
  if (!root) return files
  const visit = (id, prefix) => {
    for (const {mode,name,sha} of treeEntries(repo.objects.get(id))) {
      if (mode === '40000' || mode === '040000') visit(sha, prefix + name + '/')
      else files.set(prefix + name, {sha,mode})
    }
  }
  visit(links(root)[0], '')
  return files
}

function makeTree(repo, files) {
  const root = new Map()
  for (const [path, leaf] of files) {
    const parts = path.split('/')
    let dir = root
    for (const name of parts.slice(0,-1)) {
      if (!dir.has(name)) dir.set(name,new Map())
      dir = dir.get(name)
      if (!(dir instanceof Map)) throw Error('Conflicting file and directory')
    }
    dir.set(parts.at(-1),leaf)
  }
  function write(dir) {
    const entries = [...dir].map(([name, value]) => {
      const folder = value instanceof Map
      const {mode,sha} = folder ? {mode:'40000',sha:write(value)} : value
      return {sort:Buffer.from(name + (folder ? '/' : '')), bytes:Buffer.concat([Buffer.from(mode + ' ' + name + '\0'),Buffer.from(sha,'hex')])}
    })
    entries.sort((a,b) => Buffer.compare(a.sort,b.sort))
    return save(repo,'tree',Buffer.concat(entries.map(e => e.bytes)))
  }
  return write(root)
}

export function commitFiles(repo, branch, files, message, identity) {
  const ref = 'refs/heads/' + branch
  const parent = repo.refs.get(ref)
  const tree = makeTree(repo,files)
  const author = String(identity.name).replace(/[\n<>]/g,'') + ' <' + String(identity.email).replace(/[\n<>]/g,'') + '> ' + Math.floor(Date.now()/1000) + ' +0000'
  const sha = save(repo,'commit','tree ' + tree + '\n' + (parent ? 'parent ' + parent + '\n' : '') + 'author ' + author + '\ncommitter ' + author + '\n\n' + message + '\n')
  repo.refs.set(ref,sha)
  return sha
}
