export const DEVICE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Statecase — Device access</title>
  <link rel="stylesheet" href="/ui.css">
</head>
<body>
  <main class="shell">
    <header class="mast">
      <a class="wordmark" href="/">STATECASE<span>／01</span></a>
      <p class="eyebrow">PORTABLE OPERATIONAL CONTEXT</p>
    </header>
    <section class="hero">
      <p class="kicker">THE ENCRYPTED DROPBOX FOR AGENTS</p>
      <h1>Take your agents <em>anywhere.</em></h1>
      <p class="lede">Carry sessions, skills, context, and work in progress across every machine.</p>
    </section>
    <section class="console" aria-live="polite">
      <div class="status-line"><span class="lamp"></span><span id="session-status">Checking session…</span></div>
      <form id="auth-form" class="panel">
        <h2>Operator access</h2>
        <label>Email<input id="email" name="email" type="email" autocomplete="email" required></label>
        <label>Password<input id="password" name="password" type="password" autocomplete="current-password" minlength="12" required></label>
        <label>Name <span>(new accounts)</span><input id="name" name="name" autocomplete="name"></label>
        <div class="actions"><button type="submit" data-action="sign-in">Sign in</button><button type="button" data-action="sign-up">Create account</button></div>
      </form>
      <form id="device-form" class="panel" hidden>
        <h2>Approve a device</h2>
        <p>Only approve a code shown on a device in your possession. Never approve a code sent in a message.</p>
        <label>Device code<input id="user-code" name="userCode" inputmode="text" autocomplete="one-time-code" required></label>
        <div id="request-detail" class="request-detail"></div>
        <div class="actions"><button type="submit">Inspect request</button><button id="approve" type="button" disabled>Approve this device</button></div>
      </form>
      <p id="message" class="message"></p>
    </section>
  </main>
  <script src="/ui.js" defer></script>
</body>
</html>`;

export const UI_CSS = `
:root{--ink:#e9eadf;--muted:#9a9d8e;--black:#0a0b09;--panel:#12140f;--line:#30352a;--signal:#d8ff3e;--rust:#ff6b35}
*{box-sizing:border-box}body{margin:0;background:var(--black);color:var(--ink);font-family:Georgia,"Times New Roman",serif;min-height:100vh}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0 5px,#ffffff05 6px);mix-blend-mode:screen}
.shell{width:min(1080px,calc(100% - 36px));margin:auto;padding:28px 0 64px}.mast{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:16px}
.wordmark{color:var(--ink);text-decoration:none;font:700 18px/1 ui-monospace,"SFMono-Regular",Consolas,monospace;letter-spacing:.16em}.wordmark span{color:var(--signal)}
.eyebrow,.kicker{font:600 11px/1.4 ui-monospace,"SFMono-Regular",Consolas,monospace;letter-spacing:.18em;color:var(--muted)}
.hero{padding:clamp(64px,12vw,150px) 0 52px;display:grid;grid-template-columns:1fr minmax(280px,720px);gap:28px}.hero h1{grid-column:2;margin:0;font-size:clamp(56px,9vw,126px);line-height:.82;letter-spacing:-.065em;font-weight:400}.hero em{color:var(--signal);font-weight:400}.lede{grid-column:2;max-width:580px;font-size:20px;line-height:1.5;color:var(--muted)}
.console{margin-left:auto;width:min(720px,100%);border:1px solid var(--line);background:var(--panel);box-shadow:14px 14px 0 #171a13}.status-line{display:flex;gap:10px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);font:12px ui-monospace,"SFMono-Regular",Consolas,monospace;color:var(--muted)}.lamp{width:8px;height:8px;border-radius:50%;background:var(--signal);box-shadow:0 0 14px var(--signal)}
.panel{padding:28px;display:grid;gap:18px}.panel[hidden]{display:none}.panel h2{font-size:32px;margin:0}.panel p{margin:0;color:var(--muted);line-height:1.5}.panel label{display:grid;gap:8px;font:12px ui-monospace,"SFMono-Regular",Consolas,monospace;text-transform:uppercase;letter-spacing:.08em}.panel label span{color:var(--muted);text-transform:none}
input{width:100%;border:1px solid var(--line);border-radius:0;background:#080906;color:var(--ink);padding:14px;font:16px ui-monospace,"SFMono-Regular",Consolas,monospace;outline:none}input:focus{border-color:var(--signal);box-shadow:inset 3px 0 0 var(--signal)}
.actions{display:flex;gap:10px;flex-wrap:wrap}button{border:1px solid var(--signal);background:var(--signal);color:#101207;padding:12px 18px;font:700 12px ui-monospace,"SFMono-Regular",Consolas,monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}button+button{background:transparent;color:var(--signal)}button:disabled{opacity:.35;cursor:not-allowed}.request-detail{font:13px/1.7 ui-monospace,"SFMono-Regular",Consolas,monospace;color:var(--signal)}.message{min-height:48px;margin:0;padding:0 28px 24px;color:var(--rust);font:13px/1.5 ui-monospace,"SFMono-Regular",Consolas,monospace}
@media(max-width:720px){.eyebrow{display:none}.hero{display:block}.hero h1{margin-top:22px}.hero .lede{margin-top:28px}.console{box-shadow:7px 7px 0 #171a13}}
@media(prefers-reduced-motion:no-preference){.hero h1,.console{animation:arrive .55s cubic-bezier(.2,.8,.2,1) both}.console{animation-delay:.12s}@keyframes arrive{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}}
`;

export const UI_JAVASCRIPT = `
const byId=(id)=>document.getElementById(id);const message=byId("message");const authForm=byId("auth-form");const deviceForm=byId("device-form");const status=byId("session-status");let inspectedCode="";
async function api(path,options={}){const response=await fetch(path,{credentials:"include",headers:{"content-type":"application/json",...(options.headers||{})},...options});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error_description||data.message||data.error?.message||"Request failed");return data}
async function refresh(){const session=await api("/api/auth/get-session").catch(()=>null);if(session?.user){status.textContent="Signed in as "+session.user.email;authForm.hidden=true;deviceForm.hidden=false}else{status.textContent="Sign in to review a device";authForm.hidden=false;deviceForm.hidden=true}const code=new URLSearchParams(location.search).get("user_code");if(code)byId("user-code").value=code}
authForm.addEventListener("submit",async(event)=>{event.preventDefault();message.textContent="";try{await api("/api/auth/sign-in/email",{method:"POST",body:JSON.stringify({email:byId("email").value,password:byId("password").value})});await refresh()}catch(error){message.textContent=error.message}});
authForm.querySelector('[data-action="sign-up"]').addEventListener("click",async()=>{message.textContent="";try{await api("/api/auth/sign-up/email",{method:"POST",body:JSON.stringify({email:byId("email").value,password:byId("password").value,name:byId("name").value||"Statecase operator"})});await refresh()}catch(error){message.textContent=error.message}});
deviceForm.addEventListener("submit",async(event)=>{event.preventDefault();message.textContent="";try{const code=byId("user-code").value;const request=await api("/api/auth/device?user_code="+encodeURIComponent(code),{headers:{}});inspectedCode=code;byId("request-detail").textContent="CLIENT  "+request.client_id+"  /  SCOPE  "+(request.scope||"default");byId("approve").disabled=false}catch(error){message.textContent=error.message}});
byId("approve").addEventListener("click",async()=>{message.textContent="";try{await api("/api/auth/device/approve",{method:"POST",body:JSON.stringify({userCode:inspectedCode})});byId("approve").disabled=true;message.textContent="Device approved. You may return to the terminal."}catch(error){message.textContent=error.message}});refresh();
`;
