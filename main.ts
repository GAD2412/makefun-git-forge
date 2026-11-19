import http from 'node:http'
import {setTimeout as delay} from 'node:timers/promises'
import {rest} from './rest.ts'
import {gitRequest} from './git.ts'
import {graphql} from './graphql.ts'
import {mcp} from './mcp.ts'
import {lookup,fail} from './store.ts'

const token = process.env.MAKEFUN_SHOP_TOKEN
if (!token) throw Error('MAKEFUN_SHOP_TOKEN is required')
const env = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/,'')
const bearer = 'Bearer '+token
let requests = 0
function json(res,status,body,headers={},encoded=undefined) {
  res.statusCode = status
  res.setHeader('Content-Type','application/json; charset=utf-8')
  res.setHeader('X-GitHub-Request-Id',(++requests).toString(16))
  for (const [name,value] of Object.entries(headers)) res.setHeader(name,value)
  // end() can send a fixed-length JSON reply and its headers in one write.
  res.end(encoded ?? (body === undefined ? undefined : JSON.stringify(body)))
}
function read(req) {
  const limit = 64 * 1024 * 1024
  if (Number(req.headers['content-length']) > limit) fail(413,'Payload too large')
  return new Promise((resolve,reject)=>{
    const chunks = []
    let length = 0
    req.on('data',chunk=>{
      length += chunk.length
      if (length <= limit) chunks.push(chunk)
      else if (chunks.length) {
        chunks.length = 0
        reject(Object.assign(new Error('Payload too large'),{status:413}))
      }
    })
    req.once('error',reject)
    req.once('end',()=>{
      if (length > limit) reject(Object.assign(new Error('Payload too large'),{status:413}))
      else resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks,length))
    })
  })
}
const server=http.createServer(async (req,res)=>{
  try {
    if(req.url==='/healthz') return json(res,200,{ok:true})
    if(req.headers.authorization!==bearer) return json(res,401,{message:'Bad credentials'})
    const url = new URL(req.url,'http://'+req.headers.host)
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-receive-pack|git-upload-pack)$/.exec(url.pathname)
    if(git) {
      const repo=lookup(decodeURIComponent(git[1]),decodeURIComponent(git[2]))
      const discovery=git[3]==='info/refs'
      if(req.method !== (discovery?'GET':'POST')) fail(405,'Method Not Allowed')
      const service=discovery?url.searchParams.get('service'):git[3]
      const body=discovery?null:await read(req)
      let data
      try {data=gitRequest(repo,service,discovery,req.headers['git-protocol']?.split(':').includes('version=2'),body)}
      catch(e){fail(400,e.message)}
      res.writeHead(200,{'content-type':'application/x-'+service+(discovery?'-advertisement':'-result'),'cache-control':'no-cache','content-length':data.length})
      return res.end(data)
    }
    let body={}
    if (!['GET','HEAD'].includes(req.method)) {
      const bytes=await read(req)
      if(bytes.length) {
        try {body=JSON.parse(bytes.toString())}
        catch {return json(res,400,url.pathname==='/mcp'?{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}:{message:'Problems parsing JSON'})}
      }
    }
    if(req.method==='POST' && url.pathname==='/api/graphql') return json(res,200,Array.isArray(body)?body.map(graphql):graphql(body))
    if(req.method==='POST' && url.pathname==='/mcp') {
      const data=mcp(body)
      return json(res,data?200:202,data ?? undefined)
    }
    if(!/^\/api\/v3(?:\/|$)/.test(url.pathname)) fail(404,'Not Found')
    const result=rest(req.method,url,body)
    json(res,result.status || 200,result.body,result.headers,result.encoded)
  } catch(e){json(res,e.status || 500,{message:e.status?e.message:'Internal Server Error'})}
})
server.keepAliveTimeout=65000
server.listen(0,env?'0.0.0.0':'127.0.0.1',async ()=>{
  const port=server.address().port
  console.log('Forge listening on port '+port)
  if(!env) return
  for (;;) {
    try {
      const r=await fetch(env+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port}),signal:AbortSignal.timeout(2500)})
      if(r.ok || r.status===409) break
    } catch {}
    await delay(100)
  }
  for (;;) {
    try {
      const r=await fetch(env+'/done',{signal:AbortSignal.timeout(5000)})
      if(r.ok && (await r.json()).done) break
    } catch {}
    await delay(250)
  }
  server.close()
  server.closeAllConnections()
})
