import { ancestors, commitFiles, filesAt, links, save } from './objects.ts'

export const viewer = {login:'adaiversen', id:1, node_id:'User_1', type:'User'}
export const repos = new Map()
export const nodes = new Map()
const identity = {name:viewer.login,email:viewer.login+'@users.noreply.local'}
let sequence = 1
export function fail(status,message) { throw Object.assign(new Error(message),{status}) }
export function required(value,message='Not Found') {
  if (value === undefined || value === null) fail(404,message)
  return value
}
export function lookup(owner,name) {
  return required(owner?.toLowerCase() === viewer.login ? repos.get(name?.toLowerCase()) : null)
}
export function createRepo(input) {
  const name = input.name
  if (typeof name !== 'string' || !/^[\w.-]{1,100}$/.test(name) || name === '.' || name === '..') fail(422,'Invalid repository name')
  if (repos.has(name.toLowerCase())) fail(422,'Repository creation failed: name already exists on this account')
  const id = ++sequence, node_id = 'Repository_'+id
  const repo = {info:{id,node_id,name,full_name:viewer.login+'/'+name,owner:viewer,description:input.description ?? null,private:!!input.private,default_branch:input.default_branch || 'main',has_issues:true},
    refs:new Map(),objects:new Map(),issues:new Map(),pulls:new Map(),labels:new Map(),comments:new Map(),nextNumber:1}
  repos.set(name.toLowerCase(),repo)
  nodes.set(node_id,{kind:'Repository',repo})
  if (input.auto_init) {
    const files = new Map([['README.md',{mode:'100644',sha:save(repo,'blob','# '+name+'\n')}]])
    commitFiles(repo,repo.info.default_branch,files,'Initial commit',identity)
  }
  return repo
}
export function deleteRepo(repo) {
  repos.delete(repo.info.name.toLowerCase())
  for (const [key,x] of nodes) if (x.repo === repo) nodes.delete(key)
}
export function createIssue(repo,input) {
  if (typeof input.title !== 'string' || !input.title.trim()) fail(422,'Title is required')
  const labels = (input.labels || []).map(k => repo.labels.get(typeof k === 'string' ? k : k?.name) || fail(422,'Label does not exist'))
  const id = ++sequence, number = repo.nextNumber++, now = new Date().toISOString()
  const issue = {id,node_id:'Issue_'+id,number,title:input.title,body:input.body ?? '',state:'open',user:viewer,labels,comments:0,created_at:now,updated_at:now,closed_at:null}
  repo.issues.set(number,issue)
  nodes.set(issue.node_id,{kind:'Issue',repo,value:issue})
  return issue
}
export function updateIssue(issue,input) {
  if (input.title !== undefined) issue.title = input.title
  if (input.body !== undefined) issue.body = input.body
  if (input.state !== undefined) {
    if (!['open','closed'].includes(input.state)) fail(422,'Invalid issue state')
    issue.state = input.state
    issue.closed_at = input.state === 'closed' ? new Date().toISOString() : null
  }
  issue.updated_at = new Date().toISOString()
  return issue
}
export function comment(repo,issue,input) {
  if (typeof input.body !== 'string' || !input.body) fail(422,'Body is required')
  const id = ++sequence, now = new Date().toISOString()
  const item = {id,node_id:'IssueComment_'+id,body:input.body,user:viewer,created_at:now,updated_at:now}
  let thread = repo.comments.get(issue.number)
  if (!thread) repo.comments.set(issue.number,thread=[])
  thread.push(item)
  issue.comments++
  return item
}
export function tip(repo,ref) {
  return repo.refs.get('refs/heads/'+ref) || repo.refs.get(ref) || (repo.objects.get(ref)?.type === 'commit' ? ref : undefined)
}
export function commitView(repo,sha) {
  const obj = required(repo.objects.get(sha))
  const text = obj.data.toString('utf8')
  return {sha,commit:{message:text.slice(text.indexOf('\n\n')+2).replace(/\n$/,''),tree:{sha:links(obj)[0]}},parents:links(obj).slice(1).map(sha=>({sha})),author:viewer,committer:viewer}
}
export function content(repo,path,ref) {
  const sha = required(tip(repo,ref || repo.info.default_branch))
  const files = filesAt(repo,sha)
  const leaf = files.get(path)
  if (leaf) {
    const obj = required(repo.objects.get(leaf.sha))
    return {name:path.split('/').at(-1),path,type:'file',sha:leaf.sha,encoding:'base64',size:obj.data.length,content:obj.data.toString('base64')}
  }
  const prefix = path ? path+'/' : ''
  const names = new Map()
  for (const [file,item] of files) if (file.startsWith(prefix)) {
    const rest = file.slice(prefix.length), name = rest.split('/')[0]
    if (!names.has(name)) names.set(name,{name,path:prefix+name,type:rest.includes('/')?'dir':'file',sha:item.sha,size:rest.includes('/')?0:repo.objects.get(item.sha)?.data.length})
  }
  if (!names.size) fail(404,'Not Found')
  return [...names.values()]
}
export function editContent(repo,path,input,remove) {
  if (!path || path.split('/').some(p=>!p || p==='.' || p==='..') || typeof input.message !== 'string') fail(422,'Invalid content request')
  const branch = input.branch || repo.info.default_branch
  const head = tip(repo,branch)
  if (!head && (repo.refs.size || branch !== repo.info.default_branch)) fail(404,'Branch not found')
  const files = filesAt(repo,head), old = files.get(path)
  if (remove && !old) fail(404,'Not Found')
  if (old && input.sha !== old.sha || !old && input.sha) fail(409,'The supplied SHA does not match')
  if (remove) files.delete(path)
  else {
    if (typeof input.content !== 'string') fail(422,'Base64 content is required')
    files.set(path,{mode:old?.mode || '100644',sha:save(repo,'blob',Buffer.from(input.content,'base64'))})
  }
  const sha = commitFiles(repo,branch,files,input.message,input.committer || identity)
  return {status:old?200:201,body:{content:remove?null:content(repo,path,branch),commit:{...commitView(repo,sha).commit,sha}}}
}
export function createPull(repo,input) {
  const head = String(input.head || '').split(':').at(-1), base = input.base || repo.info.default_branch
  if (!input.title || !tip(repo,head) || !tip(repo,base) || head === base) fail(422,'Invalid pull request')
  const id = ++sequence, now = new Date().toISOString()
  const pr = {id,node_id:'PullRequest_'+id,number:repo.nextNumber++,title:input.title,body:input.body ?? '',state:'open',user:viewer,head:{ref:head,sha:tip(repo,head)},base:{ref:base,sha:tip(repo,base)},merged:false,merged_at:null,merge_commit_sha:null,created_at:now,updated_at:now}
  repo.pulls.set(pr.number,pr)
  nodes.set(pr.node_id,{kind:'PullRequest',repo,value:pr})
  return pr
}
export function pullView(repo,pr) {
  if (!pr.merged) {
    pr.head.sha = tip(repo,pr.head.ref) || pr.head.sha
    pr.base.sha = tip(repo,pr.base.ref) || pr.base.sha
  }
  return pr
}
function pullTrees(repo,pr) {
  pullView(repo,pr)
  const headHistory = ancestors(repo,pr.head.sha)
  const fork = [...ancestors(repo,pr.base.sha)].find(sha=>headHistory.has(sha))
  return {original:filesAt(repo,fork),head:filesAt(repo,pr.head.sha),base:filesAt(repo,pr.base.sha)}
}
function same(a,b) {return a?.sha === b?.sha && a?.mode === b?.mode}
function lineCount(repo,entry) {
  if (!entry) return 0
  const buf = repo.objects.get(entry.sha)?.data
  if (!buf?.length || buf.includes(0)) return 0
  let count = buf[buf.length-1] === 10 ? 0 : 1
  for (const byte of buf) if (byte === 10) count++
  return count
}
export function changes(repo,pr) {
  const {original,head,base} = pullTrees(repo,pr)
  const files = [], mergedTree = new Map(base)
  let conflict = false
  for (const name of new Set([...original.keys(),...head.keys()])) {
    const before = original.get(name), after = head.get(name)
    if (same(before,after)) continue
    if (!same(before,base.get(name)) && !same(after,base.get(name))) conflict = true
    if (after) mergedTree.set(name,after)
    else mergedTree.delete(name)
    const additions = lineCount(repo,after), deletions = lineCount(repo,before)
    files.push({filename:name,status:before ? after ? 'modified' : 'removed' : 'added',sha:(after || before).sha,additions,deletions,changes:additions+deletions})
  }
  return {files,mergedTree,conflict}
}
export function merge(repo,pr) {
  if (pr.state !== 'open') fail(405,'Pull request is not open')
  const result = changes(repo,pr)
  if (result.conflict) fail(405,'Pull Request is not mergeable')
  const sha = commitFiles(repo,pr.base.ref,result.mergedTree,pr.title,identity)
  Object.assign(pr,{state:'closed',merged:true,merged_at:new Date().toISOString(),merge_commit_sha:sha})
  return {sha,merged:true,message:'Pull Request successfully merged'}
}
