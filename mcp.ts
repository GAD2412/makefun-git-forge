import {lookup,createRepo,createIssue,createPull,merge,required} from './store.ts'

const identity = {name:'makefun-git-forge',version:'1.0.0'}
const tools = [
  ['create_repo','Create a repository for the authenticated user.',['name'],[], a=>createRepo(a).info],
  ['get_repo','Read a repository by owner and name.',['owner','repo'],[], a=>lookup(a.owner,a.repo).info],
  ['create_issue','Open an issue in a repository.',['owner','repo','title'],['body'],a=>createIssue(lookup(a.owner,a.repo),a)],
  ['list_issues','List issues by their current state.',['owner','repo'],['state'],a=>[...lookup(a.owner,a.repo).issues.values()].filter(i=>a.state==='all' || i.state===(a.state || 'open'))],
  ['create_pull_request','Open a pull request between branches.',['owner','repo','title','head','base'],['body'],a=>createPull(lookup(a.owner,a.repo),a)],
  ['merge_pull_request','Squash merge a pull request.',['owner','repo','pull_number'],[],a=>{const r=lookup(a.owner,a.repo); return merge(r,required(r.pulls.get(Number(a.pull_number))))}]
]
const descriptions = tools.map(([name,description,required,optional])=>({name,description,inputSchema:{type:'object',properties:Object.fromEntries([...required,...optional].map(k=>[k,{type:k==='pull_number'?'integer':'string'}])),required}}))
export function mcp(request) {
  const {id,method,params} = request || {}
  const envelope = {jsonrpc:'2.0',id:id ?? null}
  const error = (code,message) => ({...envelope,error:{code,message}})
  let result
  if (method === 'server/discover') result = {serverInfo:identity,supportedVersions:['2026-07-28','2025-11-25'],capabilities:{tools:{}}}
  else if (method === 'initialize') result = {serverInfo:identity,protocolVersion:params?.protocolVersion || '2025-11-25',capabilities:{tools:{}}}
  else if (method === 'notifications/initialized') return null
  else if (method === 'tools/list') result = {tools:descriptions}
  else if (method === 'tools/call') {
    const tool = tools.find(t=>t[0] === params?.name)
    if (!tool) return error(-32602,'Unknown tool')
    const args = params?.arguments || {}
    for (const key of tool[2]) if (args[key] === undefined || args[key] === null || args[key] === '') return error(-32602,'Missing '+key)
    try {
      const data = tool[4](args)
      result = {content:[{type:'text',text:JSON.stringify(data)}]}
    } catch(e) {result={isError:true,content:[{type:'text',text:e.message}]}}
  } else if (method === 'ping') result = {}
  else return error(-32601,'Method not found')
  return {...envelope,result}
}
