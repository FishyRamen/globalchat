import express from "express";
import http from "http";
import {Server} from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const db = {
  users:{},
  tokens:{},
  global:[]
};

function now(){return Date.now();}
function newToken(){return crypto.randomBytes(24).toString("hex");}

io.on("connection",(socket)=>{

  socket.on("login",({username,password,guest})=>{
    if(guest){
      const g = "Guest"+Math.floor(1000+Math.random()*9000);
      socket.emit("loginSuccess",{username:g,guest:true});
      return;
    }

    if(!/^[A-Za-z0-9]{4,20}$/.test(username)){
      socket.emit("loginError","Invalid username.");
      return;
    }

    let user = db.users[username];
    if(!user){
      user = db.users[username] = {
        pass:password,
        xp:0,
        level:1
      };
    } else if(user.pass !== password){
      socket.emit("loginError","Wrong password.");
      return;
    }

    const token = newToken();
    db.tokens[token]=username;
    socket.emit("loginSuccess",{username,token});
  });

  socket.on("sendGlobal",({text})=>{
    const msg = {user:"User",text,ts:now()};
    db.global.push(msg);
    io.emit("globalMessage",msg);
  });

  socket.emit("onlineUsers",Object.keys(db.users).map(u=>({user:u})));
});

server.listen(3000);
