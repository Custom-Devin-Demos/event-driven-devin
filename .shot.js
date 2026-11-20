const { chromium } = require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://localhost:29229');const c=b.contexts()[0];const p=await c.newPage();await p.setViewportSize({width:1100,height:1300});
await p.goto('file:///home/ubuntu/pdlc-shots/thread.html');await p.waitForTimeout(2000);
const H=await p.evaluate(()=>document.body.scrollHeight);console.log('H',H);
let i=1;for(let y=0;y<H;y+=1240){await p.evaluate(v=>window.scrollTo(0,v),y);await p.waitForTimeout(300);await p.screenshot({path:`/home/ubuntu/pdlc-shots/thread-${i++}.png`});}
await p.close();})();
