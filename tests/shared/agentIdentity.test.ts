import {describe,expect,it} from 'vitest'
import {AGENT_MASCOT_SHAPES,AGENT_MASCOT_BODIES,AGENT_MASCOT_COLORS,AGENT_MASCOT_EXPRESSIONS,AGENT_IMAGE_CROPS,agentIdentityFromProfile,agentIdentityMetadata,defaultAgentIdentity,decodeAgentAvatar,encodeAgentAvatar,normalizeAvatar,YAOYAO_AGENT_IDENTITY_NAMESPACE} from '../../src/shared/agentIdentity'
const photo='data:image/png;base64,aGVsbG8='
describe('avatar v2',()=>{
 it('resets legacy internal appearance while retaining the configured name',()=>{
  const identity=agentIdentityFromProfile({name:'bot',ui_meta:{[YAOYAO_AGENT_IDENTITY_NAMESPACE]:{version:1,display_name:'瑶儿',avatar_mode:'mascot',shape:'triangle',color:'#ff0000',expression:'curious'}}})
  expect(identity).toMatchObject({displayName:'瑶儿',shape:'circle',color:'#00c875',expression:'idle',bodyId:null})
  expect(decodeAgentAvatar('yaoyao-mascot:v1:triangle:ff0000:curious')).toMatchObject({shape:'circle',color:'#00c875',expression:'idle'})
 })
 it('retains raw photo bytes and uses the prior rounded crop',()=>{
  const decoded=decodeAgentAvatar(normalizeAvatar(photo))
  expect(decoded).toMatchObject({avatarMode:'image',imageDataURL:photo,imageCrop:'rounded'})
  expect(agentIdentityFromProfile({name:'bot',ui_meta:{[YAOYAO_AGENT_IDENTITY_NAMESPACE]:{version:1,avatar_mode:'image',image_data_url:photo}}})).toMatchObject({avatarMode:'image',imageDataURL:photo})
 })
 it('retains hidden photos when resetting the old mascot',()=>{
  expect(agentIdentityFromProfile({name:'bot',ui_meta:{[YAOYAO_AGENT_IDENTITY_NAMESPACE]:{version:1,avatar_mode:'mascot',image_data_url:photo}}})).toMatchObject({avatarMode:'mascot',imageDataURL:photo,color:'#00c875'})
 })
 it('round trips every supported picker value and metadata without resetting v2',()=>{
  expect([AGENT_MASCOT_COLORS.length,AGENT_MASCOT_SHAPES.length,AGENT_MASCOT_BODIES.length,AGENT_MASCOT_EXPRESSIONS.length]).toEqual([11,8,10,10])
  for(const shape of AGENT_MASCOT_SHAPES) for(const bodyId of [null,...AGENT_MASCOT_BODIES]) {
   const identity={...defaultAgentIdentity('bot'),shape,bodyId,color:'#1488ff' as const,expression:'proud' as const}
   const encoded=encodeAgentAvatar(identity)
   expect(normalizeAvatar(encoded)).toBe(encoded)
   expect(decodeAgentAvatar(encoded)).toMatchObject({shape,bodyId,color:'#1488ff',expression:'proud'})
   expect(agentIdentityFromProfile({name:'bot',ui_meta:{[YAOYAO_AGENT_IDENTITY_NAMESPACE]:agentIdentityMetadata(identity)}})).toEqual(identity)
  }
  for(const imageCrop of AGENT_IMAGE_CROPS) expect(decodeAgentAvatar(encodeAgentAvatar({...defaultAgentIdentity('bot'),avatarMode:'image',imageDataURL:photo,imageCrop}))).toMatchObject({imageDataURL:photo,imageCrop})
 })
 it('uses the same green circle for all defaults, regardless of name or role',()=>{
  for(const name of ['samien','developer','研究员']) expect(defaultAgentIdentity(name)).toMatchObject({shape:'circle',color:'#00c875',expression:'idle'})
 })
 it('rejects untrusted geometry, invalid crops and external image URLs',()=>{
  const base={...defaultAgentIdentity('bot')}
  for(const patch of [{shape:'<script>'},{bodyId:'untrusted'},{color:'url(https://x)'},{imageCrop:'blob'},{avatarMode:'image',imageDataURL:'https://external.test/avatar.png'}]) {
   expect(decodeAgentAvatar('yaoyao-avatar:v2:'+JSON.stringify({...base,...patch}))).toBeNull()
  }
 })
})
