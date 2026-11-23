#!/usr/bin/env node
/** distiller 单测：幻觉防护 + JSON 解析 + 模型路由 */
import assert from 'node:assert/strict';
const D = await import('../../lib/memory/distiller.js');

let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l)}else{fail++;console.log('  ❌ '+l+(d?' — '+d:''))} };

console.log('\nT1 幻觉/敏感内容拦截');
{
  const cases=[
    ['张三说他喜欢猫', '张三', true, '正常偏好'],
    ['张三可能喜欢猫', '张三', false, '推测语气'],
    ['张三欠了李四50元', '张三', false, '金钱'],
    ['张三的手机号是138xxxx', '张三', false, '隐私'],
    ['张三最近住院了', '张三', false, '健康'],
    ['李四喜欢狗', '张三', false, '没提到本人'],
    ['张三他喜欢猫', '张三', true, '用代词也算'],
    ['短', '张三', false, '太短'],
  ];
  for(const [fact,name,expect,desc] of cases){
    const r=D.isFactAcceptable(fact,name);
    ok(r.ok===expect, desc, r.reason||'');
  }
}

console.log('\nT2 JSON 解析（容忍脏输出）');
{
  ok(D.parseFactsJson('[{"name":"A","fact":"B"}]').length===1, '标准 JSON');
  ok(D.parseFactsJson('```json\n[{"name":"A","fact":"B"}]\n```').length===1, '代码块包裹');
  ok(D.parseFactsJson('好的，结果如下：[{"name":"A","fact":"B"}] 完毕').length===1, '前后有废话');
  ok(D.parseFactsJson('不是JSON').length===0, '非 JSON 返回空');
  ok(D.parseFactsJson('[]').length===0, '空数组');
}

console.log('\nT3 模型路由（走默认模型）');
{
  const fake={ currentModel:{provider:'p1',model:'m1'}, listProviders:async()=>[], listModels:async()=>[] };
  const r=await D.resolveDefaultRoute(fake);
  ok(r?.model==='m1', '优先用 currentModel');
  
  const fake2={ listProviders:async()=>[{id:'p2'}], listModels:async()=>[{id:'m2'}] };
  const r2=await D.resolveDefaultRoute(fake2);
  ok(r2?.model==='m2', '无 currentModel 时退化到第一个');
  
  ok((await D.resolveDefaultRoute({}))===undefined, '啥都没有返回 undefined');
}

console.log('\nT4 prompt 构造');
{
  const p=D.buildExtractPrompt({messages:[{name:'张三',text:'我喜欢猫',at:0}],groupName:'g'});
  ok(p.includes('张三'), '含发言人');
  ok(p.includes('绝对不记'), '含禁止清单');
  ok(p.includes('JSON'), '要求 JSON');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if(fail) process.exitCode=1;
