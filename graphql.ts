import { viewer,repos,nodes,createIssue,updateIssue,comment,createPull,pullView,merge,changes,required } from './store.ts'

function parse(source,vars) {
  if (typeof source !== 'string' || source.length > 100000) throw Error('Invalid query')
  const token = /\s+|,|#[^\n]*|\.\.\.|[_A-Za-z]\w*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|[!$():={}\[\]@|]/gy
  const tokens = []
  for (let pos=0;pos<source.length;) {
    token.lastIndex = pos
    const match = token.exec(source)
    if (!match) throw Error('Unexpected character at '+pos)
    pos = token.lastIndex
    if (!/^[\s,#]/.test(match[0])) tokens.push(match[0])
  }
  const fragments = new Map(), operations = []
  let at = 0
  const peek = () => tokens[at]
  const take = () => {if (at>=tokens.length) throw Error('Unexpected end of query'); return tokens[at++]}
  const need = x => {if(take()!==x) throw Error('Expected '+x)}
  function value() {
    const t = take()
    if (t === '$') return vars[take()]
    if (t === '{') return argumentsUntil('}')
    if (t === '[') {
      const items = []
      while (peek()!==']') items.push(value())
      take()
      return items
    }
    if (t.startsWith('"') || /^[-0-9]/.test(t) || ['true','false','null'].includes(t)) return JSON.parse(t)
    return t
  }
  function argumentsUntil(end) {
    const args = Object.create(null)
    while (peek()!==end) {
      const name = take()
      need(':')
      args[name]=value()
    }
    take()
    return args
  }
  function group(depth=0) {
    if (depth > 50) throw Error('Query is too deeply nested')
    need('{')
    const fields = []
    while (peek()!=='}') {
      const alias = take()
      if (alias === '...') {
        const target=take()
        if (target === 'on') {const type=take(); fields.push({type,fields:group(depth+1)})}
        else fields.push({fragment:target})
        continue
      }
      let name=alias
      if (peek()===':') {take();name=take()}
      let args={}
      if (peek()==='(') {take();args=argumentsUntil(')')}
      let include=true
      while (peek()==='@') {
        take()
        const directive = take()
        need('(')
        const test=argumentsUntil(')').if
        if (directive==='skip' && test || directive==='include' && !test) include=false
      }
      const children = peek()==='{' ? group(depth+1) : null
      if(include) fields.push({alias,name,args,children})
    }
    take()
    return fields
  }
  while (peek()) {
    if (peek()==='fragment') {
      take();const name=take();need('on');const type=take()
      fragments.set(name,{type,fields:group()})
    } else {
      let kind='query', name
      if (peek()!=='{') {
        kind=take()
        if (!['query','mutation'].includes(kind)) throw Error('Unsupported operation')
        if (peek()!=='(' && peek()!=='{') name=take()
        if (peek()==='(') {
          take()
          let depth=1
          while (depth) {const t=take();if(t==='(') depth++; if(t===')') depth--}
        }
      }
      operations.push({name,kind,fields:group()})
    }
  }
  return {fragments,operations}
}
const schema = {
  User:'id databaseId login', Repository:'id databaseId name nameWithOwner owner defaultBranchRef viewerPermission hasIssuesEnabled issue issues pullRequests pullRequest',
  Issue:'id number title state body', PullRequest:'id number title body headRefName baseRefName mergeable state merged files',
  SearchType:''
}
function connection(list,args) {
  const start = args.after ? Number(Buffer.from(args.after,'base64').toString()) : 0
  const first = Math.min(100,Math.max(0,Number(args.first ?? 30)))
  const items = list.slice(start,start+first)
  const cursor = i => Buffer.from(String(i)).toString('base64')
  return {nodes:items,totalCount:list.length,edges:items.map((node,i)=>({node,cursor:cursor(start+i+1)})),pageInfo:{hasNextPage:start+items.length<list.length,hasPreviousPage:start>0,endCursor:items.length?cursor(start+items.length):null}}
}
const user = {__typename:'User',login:viewer.login,id:viewer.node_id,databaseId:viewer.id}
const issue = i => i ? {__typename:'Issue',id:i.node_id,number:i.number,title:i.title,body:i.body,state:i.state.toUpperCase()} : null
function pull(repo,p) {
  if (!p) return null
  pullView(repo,p)
  return {__typename:'PullRequest',id:p.node_id,number:p.number,title:p.title,body:p.body,state:p.merged?'MERGED':p.state.toUpperCase(),merged:p.merged,headRefName:p.head.ref,baseRefName:p.base.ref,
    mergeable:()=>changes(repo,p).conflict?'CONFLICTING':'MERGEABLE',files:a=>connection(changes(repo,p).files.map(f=>({path:f.filename,additions:f.additions,deletions:f.deletions})),a)}
}
function repository(r) {
  if (!r) return null
  return {__typename:'Repository',id:r.info.node_id,databaseId:r.info.id,name:r.info.name,nameWithOwner:r.info.full_name,owner:user,defaultBranchRef:{name:r.info.default_branch},viewerPermission:'ADMIN',hasIssuesEnabled:true,
    issue:a=>issue(r.issues.get(a.number)),pullRequest:a=>pull(r,r.pulls.get(a.number)),
    issues:a=>{
      const items = [...r.issues.values()].filter(i=>!a.states || a.states.includes(i.state.toUpperCase()))
      if(a.orderBy?.direction!=='ASC') items.reverse()
      return connection(items.map(issue),a)
    },pullRequests:a=>connection([...r.pulls.values()].reverse().map(p=>pull(r,p)),a)}
}
function resolveNode(id,kind) {
  const n = required(nodes.get(id))
  if (kind && n.kind!==kind) throw Error('Wrong node type')
  return n
}
const query = {
  viewer:user,
  repository:({owner,name})=>owner?.toLowerCase()===viewer.login ? repository(repos.get(name.toLowerCase())) : null,
  node:({id})=>{const n=nodes.get(id); if(!n) return null; if(n.kind==='Repository') return repository(n.repo); return n.kind==='Issue'?issue(n.value):pull(n.repo,n.value)},
  __type:({name})=>Object.hasOwn(schema,name) ? {name,fields:schema[name].split(' ').filter(Boolean).map(name=>({name})),enumValues:name==='SearchType'?[{name:'ISSUE'},{name:'REPOSITORY'},{name:'USER'}]:null} : null
}
const mutation = {
  createIssue:({input})=>({issue:issue(createIssue(resolveNode(input.repositoryId,'Repository').repo,input))}),
  closeIssue:({input})=>({issue:issue(updateIssue(resolveNode(input.issueId,'Issue').value,{state:'closed'}))}),
  createPullRequest:({input})=>{const r=resolveNode(input.repositoryId,'Repository').repo;return {pullRequest:pull(r,createPull(r,{...input,head:input.headRefName,base:input.baseRefName}))}},
  mergePullRequest:({input})=>{const n=resolveNode(input.pullRequestId,'PullRequest');merge(n.repo,n.value);return {pullRequest:pull(n.repo,n.value)}},
  addComment:({input})=>{const n=resolveNode(input.subjectId,'Issue');const c=comment(n.repo,n.value,input);return {commentEdge:{node:{body:c.body,id:c.node_id}}}}
}
export function graphql(request) {
  try {
    const {operations,fragments}=parse(request.query,request.variables || {})
    const op=request.operationName ? operations.find(o=>o.name===request.operationName) : operations.length===1 ? operations[0] : undefined
    if(!op) throw Error('Select an operation')
    let budget=100000
    function project(obj,fields,depth=0) {
      if (--budget < 0 || depth>80) throw Error('Query exceeds execution limit')
      if (obj==null || !fields) return obj ?? null
      if(Array.isArray(obj)) return obj.map(item=>project(item,fields,depth+1))
      const out=Object.create(null)
      for(const f of fields) {
        if(f.fragment || f.type) {
          const fragment=f.fragment ? fragments.get(f.fragment) : f
          if(!fragment) throw Error('Unknown fragment '+f.fragment)
          if(fragment.type===obj.__typename) Object.assign(out,project(obj,fragment.fields,depth+1))
          continue
        }
        if(!Object.hasOwn(obj,f.name)) throw Error('Unknown field '+f.name+' on '+(obj.__typename || 'this type'))
        const val=obj[f.name]
        out[f.alias]=project(typeof val==='function'?val(f.args):val,f.children,depth+1)
      }
      return out
    }
    return {data:project(op.kind==='mutation'?mutation:query,op.fields)}
  } catch(e) {return {errors:[{message:e.message}]}}
}
