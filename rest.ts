import { viewer,repos,lookup,createRepo,deleteRepo,required,fail,tip,content,editContent,commitView,createIssue,issueJSON,updateIssue,comment,createPull,pullView,changes,merge } from './store.ts'
import {ancestors} from './objects.ts'

function page(items,url) {
  const per = Math.min(100, Math.max(1,parseInt(url.searchParams.get('per_page')) || 30))
  const n = Math.max(1,parseInt(url.searchParams.get('page')) || 1)
  const last = Math.ceil(items.length / per)
  const link = (num,rel) => {
    const u = new URL(url)
    u.searchParams.set('page',String(num))
    return '<'+u+'>; rel="'+rel+'"'
  }
  const links = []
  if (n < last) links.push(link(n+1,'next'),link(last,'last'))
  if (n > 1) links.push(link(1,'first'),link(n-1,'prev'))
  return {body:items.slice((n-1)*per,n*per),headers:links.length ? {link:links.join(', ')} : {}}
}
export function rest(method,url,body) {
  const parts = url.pathname.replace(/^\/api\/v3\/?/,'').split('/').filter(Boolean).map(decodeURIComponent)
  const [area,owner,name,resource,item,sub] = parts
  const get = method === 'GET', post = method === 'POST'
  const list = items => page(items,url)
  if (!area && get) return {body:{current_user_url:url.origin+'/api/v3/user',repository_url:url.origin+'/api/v3/repos/{owner}/{repo}'},headers:{'X-OAuth-Scopes':'repo, read:org'}}
  if (area === 'meta' && get) return {body:{installed_version:'3.15.0'}}
  if (area === 'user' && !owner && get) return {body:viewer}
  if (area === 'user' && owner === 'repos') {
    if (post) return {status:201,body:createRepo(body).info}
    if (get) return list([...repos.values()].map(r=>r.info))
  }
  if (area !== 'repos') fail(404,'Not Found')
  const repo = lookup(owner,name)
  if (!resource) {
    if (get) return {body:repo.info}
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.info.description = body.description
      return {body:repo.info}
    }
    if (method === 'DELETE') { deleteRepo(repo); return {status:204} }
  }
  if (resource === 'contents') {
    const path = parts.slice(4).join('/')
    if (get) return {body:content(repo,path,url.searchParams.get('ref'))}
    if (method === 'PUT' || method === 'DELETE') return editContent(repo,path,body,method === 'DELETE')
  }
  if (resource === 'git' && ['refs','ref'].includes(item)) {
    const ref = post ? body.ref : 'refs/'+parts.slice(5).join('/')
    if (post) {
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || repo.refs.has(ref) || !repo.objects.has(body.sha)) fail(422,'Invalid reference')
      repo.refs.set(ref,body.sha)
    }
    if (get || post) {
      const sha = required(repo.refs.get(ref))
      return {status:post?201:200,body:{ref,object:{type:repo.objects.get(sha).type,sha}}}
    }
  }
  if (resource === 'branches' && get) {
    const branches = [...repo.refs].filter(([r])=>r.startsWith('refs/heads/')).map(([r,sha])=>({name:r.slice(11),commit:{sha},protected:false}))
    return item ? {body:required(branches.find(b=>b.name === parts.slice(4).join('/')))} : list(branches)
  }
  if (resource === 'commits' && get) {
    const sha = required(tip(repo,item || url.searchParams.get('sha') || repo.info.default_branch))
    return item ? {body:commitView(repo,sha)} : list([...ancestors(repo,sha)].map(id=>commitView(repo,id)))
  }
  if (resource === 'labels') {
    if (get) return list([...repo.labels.values()])
    if (post && body.name) {
      if (repo.labels.has(body.name)) fail(422,'Label already exists')
      const label = {id:repo.labels.size+1,name:body.name,color:body.color || 'ededed',description:body.description ?? null}
      repo.labels.set(label.name,label)
      return {status:201,body:label}
    }
  }
  if (resource === 'issues') {
    if (!item && post) return {status:201,body:createIssue(repo,body)}
    if (!item && get) {
      const state = url.searchParams.get('state') || 'open'
      const issues = [...repo.issues.values()].filter(i=>state === 'all' || i.state === state)
      if (url.searchParams.get('direction') !== 'asc') issues.reverse()
      return list(issues)
    }
    const issue = required(repo.issues.get(Number(item)))
    if (!sub && get) return {encoded:issueJSON(issue)}
    if (!sub && method === 'PATCH') return {body:updateIssue(issue,body)}
    if (sub === 'comments' && post) return {status:201,body:comment(repo,issue,body)}
    if (sub === 'comments' && get) return list(repo.comments.get(issue.number) || [])
  }
  if (resource === 'pulls') {
    if (!item && post) return {status:201,body:createPull(repo,body)}
    if (!item && get) {
      const state = url.searchParams.get('state') || 'open'
      return list([...repo.pulls.values()].filter(p=>state === 'all' || p.state === state).map(p=>pullView(repo,p)).reverse())
    }
    const pr = required(repo.pulls.get(Number(item)))
    if (!sub && get) return {body:pullView(repo,pr)}
    if (sub === 'merge' && method === 'PUT') return {body:merge(repo,pr)}
    if (sub === 'files' && get) return list(changes(repo,pr).files)
  }
  fail(404,'Not Found')
}
