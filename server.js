import express from "express";
import http from "http";
import { Server } from "socket.io";
import mysql from "mysql2";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- CẤU HÌNH EXPRESS ----------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**************************************************
 * BEGIN MEMBER 2 - DATABASE & WORD PACKS
 * Phạm vi: MySQL connection + đọc JSON bộ từ + helper DB dùng chung
 **************************************************/

// ---------- KẾT NỐI MYSQL ----------
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "wordgame",
});

db.connect((err) => {
  if (err) {
    console.error("❌ Database error (Users):", err.code);
    return;
  }
  console.log("✅ Connected to MySQL database 'wordgame' (for Users).");
});

// ---------- BIẾN TOÀN CỤC ----------
const MAX_ROUNDS = 5;
const ROUND_TIME = 30;

let rooms = [];
let wordPacks = {};
let onlineUsers = {}; // userId -> socketId

// ---------- ĐỌC TỪ VỰNG TỪ JSON ----------
function loadWordsFromJson(filename) {
  try {
    const filePath = path.join(__dirname, filename);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    // Chuẩn hóa: nếu file dùng "images" thì convert -> "image" (chọn 1 ảnh)
    const normalized = data
      .map((item) => {
        if (!item) return null;

        // word / meaning
        const word = String(item.word || "").trim();
        const meaning = String(item.meaning || "").trim();
        if (!word || !meaning) return null;

        // image
        let image = item.image;
        const images = item.images;

        // Nếu image là mảng -> random 1
        const pickOneImage = (candidate) => {
          if (!candidate) return null;

          if (typeof candidate === "string") {
            const s = candidate.trim();
            return s ? s : null;
          }

          if (Array.isArray(candidate)) {
            const arr = candidate
              .filter((x) => typeof x === "string")
              .map((x) => x.trim())
              .filter(Boolean);

            if (arr.length === 0) return null;

            // nếu có nhiều ảnh -> random 1 ảnh mỗi round
            return arr[Math.floor(Math.random() * arr.length)];
          }

          // kiểu khác -> bỏ
          return null;
        };

        if (!image && images) {
          image = pickOneImage(images);
        } else {
          image = pickOneImage(image);
        }

        // Nếu vẫn không có ảnh -> để null (client có thể fallback)
        return { word, meaning, image };
      })
      .filter(Boolean);

    return normalized;
  } catch (err) {
    console.error(`❌ Lỗi đọc file ${filename}:`, err.message);
    return [];
  }
}

function loadAllWordPacks() {
  // Bạn có thể đổi key theo packName bạn muốn
  const packGeneral = loadWordsFromJson("words.json");
  const packAnimals = loadWordsFromJson("words_animals.json");
  const packJobs = loadWordsFromJson("words_jobs.json");

  wordPacks = {
    general: packGeneral,
    animals: packAnimals,
    jobs: packJobs,
  };

  const total = Object.values(wordPacks).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`✅ Loaded ${total} words from 3 JSON files.`);
}

loadAllWordPacks();

// ---------- HÀM TIỆN ÍCH ----------
function getRoomById(roomId) {
  return rooms.find((r) => r.id === roomId);
}

function safeStr(s) {
  return typeof s === "string" ? s.trim() : "";
}

function sanitizePackName(pack) {
  const k = safeStr(pack);
  if (!k) return "general";
  if (!wordPacks[k]) return "general";
  return k;
}

function getRandomWordFromPack(packName) {
  const pack = wordPacks[packName] || [];
  if (pack.length === 0) return null;
  return pack[Math.floor(Math.random() * pack.length)];
}

function nowISO() {
  return new Date().toISOString();
}

function toPublicRoom(room) {
  return {
    id: room.id,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    players: room.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      score: p.score || 0,
      isOwner: p.userId === room.ownerId,
    })),
    state: room.state,
    mode: room.mode,
    wordPack: room.wordPack,
    round: room.round,
    maxRounds: room.maxRounds,
    createdAt: room.createdAt,
  };
}

/**************************************************
 * END Tran nhu dat
 **************************************************/
/**************************************************
* BEGIN MEMBER tung - MULTIPLAYER ROOMS 
 * Phạm vi: cấu trúc rooms + logic phòng chơi nhiều người
 **************************************************/

// ---------- GAME ĐA NGƯỜI (ROOM) ----------
function createRoom(owner) {
  const roomId = uuidv4().slice(0, 8);
  const room = {
    id: roomId,
    ownerId: owner.userId,
    ownerName: owner.username,
    players: [
      {
        userId: owner.userId,
        username: owner.username,
        socketId: owner.socketId,
        score: 0,
      },
    ],
    state: "waiting", // waiting | playing | ended
    mode: "normal", // normal | reverse
    wordPack: "general", // general | animals | jobs
    round: 0,
    maxRounds: MAX_ROUNDS,
    currentWord: null,
    timeLeft: ROUND_TIME,
    timer: null,
    createdAt: nowISO(),
  };
  rooms.push(room);
  return room;
}

function removeRoom(roomId) {
  rooms = rooms.filter((r) => r.id !== roomId);
}

function addPlayerToRoom(room, player) {
  const exists = room.players.find((p) => p.userId === player.userId);
  if (exists) return false;

  room.players.push({
    userId: player.userId,
    username: player.username,
    socketId: player.socketId,
    score: 0,
  });
  return true;
}

function removePlayerFromRoom(room, socketId) {
  room.players = room.players.filter((p) => p.socketId !== socketId);
}

function getPlayerInRoom(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function setRoomOwnerIfNeeded(room) {
  if (room.players.length === 0) return;
  // nếu owner rời -> set owner mới là player đầu tiên
  const ownerStillHere = room.players.some((p) => p.userId === room.ownerId);
  if (!ownerStillHere) {
    room.ownerId = room.players[0].userId;
    room.ownerName = room.players[0].username;
  }
}

function broadcastRoomUpdate(room) {
  io.to(room.id).emit("roomUpdate", toPublicRoom(room));
}

/**************************************************
 * END MEMBER tung
 **************************************************/