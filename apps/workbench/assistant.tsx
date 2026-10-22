import React, { useEffect, useState } from 'react';
import { Settings2, Sparkles, X, Square } from 'lucide-react';
import { api } from './api';

type Settings = {baseURL:string;model:string;hasKey:boolean;encryptionAvailable:boolean};
export function ModelSettingsDialog({onClose}:{onClose:()=>void}) {
  const [config,setConfig]=useState<Settings|null>(null),[key,setKey]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{api<Settings>('settings.get').then(setConfig).catch(e=>setError(e.message));},[]);
  return <div className="modal-backdrop"><form className="modal settings-modal" role="dialog" aria-modal="true" aria-label="模型设置" onSubmit={async e=>{e.preventDefault();setSaving(true);try{await api('settings.save',{...config,apiKey:key});setKey('');onClose();}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}>
    <div className="modal-heading"><h2>模型设置</h2><button type="button" aria-label="关闭模型设置" onClick={onClose}><X/></button></div>
    <p className="muted">AI 任务通过官方 DeepSeek Harness 运行。开始生成时，选区和当前章节会发送到你配置的模型服务。</p>
    {config&&<><label>服务地址<input value={config.baseURL} onChange={e=>setConfig({...config,baseURL:e.target.value})}/></label><label>模型名称<input value={config.model} onChange={e=>setConfig({...config,model:e.target.value})}/></label><label>API Key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={config.hasKey?'已安全保存，留空保持原值':'输入 API Key'}/></label><p className="muted">凭据使用系统安全存储加密，界面不会读回已有密钥。</p>{config.hasKey&&<button type="button" onClick={async()=>{try{setConfig(await api('settings.save',{...config,clearKey:true}));}catch(e){setError((e as Error).message);}}}>清除已保存的密钥</button>}</>}
    {error&&<p role="alert" className="inline-error">{error}</p>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={!config||saving}>{saving?'保存中…':'保存设置'}</button></div>
  </form></div>;
}
export type WritingSnapshot = {chapterId:string;body:string;start:number;end:number};
export function WritingAssistant({snapshot,apply,openSettings}:{snapshot:WritingSnapshot|null;apply:(base:WritingSnapshot,candidate:string)=>Promise<boolean>;openSettings:()=>void}) {
  const [skills,setSkills]=useState<{id:string;name:string}[]>([]),[skillId,setSkillId]=useState('novel-polish'),[instruction,setInstruction]=useState('保留情节和人物意图，改善表达。');
  const [running,setRunning]=useState(false),[error,setError]=useState(''),[proposal,setProposal]=useState<{text:string;base:WritingSnapshot}|null>(null);
  useEffect(()=>{api<typeof skills>('skills.list').then(setSkills).catch(e=>setError(e.message));},[]);
  const selected=snapshot?snapshot.body.slice(snapshot.start,snapshot.end):'';
  async function generate(){
    if(!snapshot)return;
    const base={...snapshot};setError('');setRunning(true);
    try{const result=await api<{text:string}>('ai.generate',{skillId,instruction,context:base.body,selectedText:base.body.slice(base.start,base.end)});setProposal({text:result.text,base});}catch(e){setError((e as Error).message);}finally{setRunning(false);}
  }
  return <section className="assistant"><div className="assistant-heading"><h3><Sparkles size={16}/>写作助理</h3><button title="模型设置" onClick={openSettings}><Settings2 size={16}/></button></div><label>创作方法<select aria-label="创作方法" value={skillId} onChange={e=>setSkillId(e.target.value)}>{skills.map(skill=><option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label><label>这次怎样修改<textarea aria-label="写作要求" value={instruction} onChange={e=>setInstruction(e.target.value)} maxLength={8000}/></label><p className="selection-hint">{selected?`已选中 ${Array.from(selected).length} 字`:'未选择正文，候选可插入光标位置'}</p>{running?<button className="cancel-task" onClick={()=>api('ai.cancel').catch(e=>setError(e.message))}><Square size={14}/>取消生成</button>:<button className="primary" disabled={!snapshot||!instruction.trim()} onClick={generate}><Sparkles size={16}/>生成候选</button>}{error&&<p role="alert" className="inline-error">{error}</p>}
    {proposal&&<div className="modal-backdrop"><div className="modal proposal-modal" role="dialog" aria-modal="true" aria-label="审阅 AI 候选"><div className="modal-heading"><h2>审阅 AI 候选</h2><button aria-label="关闭候选" onClick={()=>setProposal(null)}><X/></button></div><p className="muted">接受后成为编辑中的正文，并保留历史版本。生成期间正文如有变化，将拒绝替换。</p><div className="conflict-columns"><section><h3>原文选区</h3><pre>{proposal.base.body.slice(proposal.base.start,proposal.base.end)||'（插入新内容）'}</pre></section><section><h3>候选文本</h3><textarea aria-label="候选文本" value={proposal.text} onChange={e=>setProposal({...proposal,text:e.target.value})}/></section></div><div className="modal-actions"><button onClick={()=>setProposal(null)}>暂不采用</button><button className="primary" onClick={async()=>{if(await apply(proposal.base,proposal.text))setProposal(null);}}>接受候选</button></div></div></div>}
  </section>;
}
