const socket = io();
const $ = id => document.getElementById(id);

const loginOverlay = $("loginOverlay");
const app = $("app");
const loading = $("loading");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const mePill = $("mePill");
const inboxBtn = $("inboxBtn");
const inboxPing = $("inboxPing");
const globalBtn = $("globalBtn");
const onlineList = $("onlineList");

let me = null;
let token = localStorage.getItem("tonkotsu_token");
let cooldownUntil = 0;
let idleTimer = null;
let userColor = `hsl(${Math.random()*360},70%,70%)`;

function showLoading(){
  loading.classList.remove("hidden");
}
function hideLoading(){
  loading.classList.add("hidden");
}

togglePass.onclick = ()=>{
  passwordEl.type = passwordEl.type === "password" ? "text" : "password";
};

joinBtn.onclick = ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value.trim();
  if(!/^[A-Za-z0-9]{4,20}$/.test(u) || !/^[A-Za-z0-9]{4,20}$/.test(p)){
    alert("Username and password must be 4+ letters/numbers only.");
    return;
  }
  showLoading();
  socket.emit("login",{username:u,password:p});
};

guestBtn.onclick = ()=>{
  showLoading();
  socket.emit("login",{guest:true});
};

socket.on("loginSuccess",(data)=>{
  me = data.username;
  localStorage.setItem("tonkotsu_token", data.token||"");
  loginOverlay.classList.add("hidden");
  app.classList.remove("hidden");
  hideLoading();
});

socket.on("loginError",(msg)=>{
  hideLoading();
  alert(msg);
});

socket.on("onlineUsers",(list)=>{
  onlineList.innerHTML = "";
  list.forEach(u=>{
    const row = document.createElement("div");
    row.className="row";
    row.innerHTML = `<span style="color:${userColor}">${u.user}</span>`;
    row.onclick=()=>openProfile(u.user);
    onlineList.appendChild(row);
  });
});

function openProfile(user){
  alert(`Profile: ${user}\nFriend | Block`);
}

sendBtn.onclick = sendMessage;
messageEl.onkeydown = e=>{
  if(e.key==="Enter") sendMessage();
};

function sendMessage(){
  if(Date.now()<cooldownUntil) return;
  const txt = messageEl.value.trim();
  if(!txt) return;
  socket.emit("sendGlobal",{text:txt});
  cooldownUntil = Date.now() + 3000;
  messageEl.value="";
}

socket.on("globalMessage",(msg)=>{
  const d = document.createElement("div");
  d.className="msg";
  d.innerHTML = `<div class="bubble"><b style="color:${userColor}">${msg.user}</b>: ${msg.text}</div>`;
  chatBox.appendChild(d);
  chatBox.scrollTop = chatBox.scrollHeight;
});

let idleSince = Date.now();
document.onmousemove = document.onkeydown = ()=>{
  idleSince = Date.now();
  socket.emit("status:set",{status:"online"});
};

setInterval(()=>{
  if(Date.now()-idleSince>180000){
    socket.emit("status:set",{status:"idle"});
  }
},10000);
