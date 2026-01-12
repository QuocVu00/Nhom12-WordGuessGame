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
/**************************************************
 * BEGIN MEMBER 3 - AUTH API (LOGIN/REGISTER)
 * Phạm vi: /api/login, /api/register, validate user, bcrypt...
 **************************************************/

// ---------- API AUTH ----------
app.post("/api/register", async (req, res) => {
  try {
    const username = safeStr(req.body.username);
    const password = safeStr(req.body.password);

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: "Thiếu username/password." });
    }

    // check exists
    db.query("SELECT id FROM users WHERE username = ?", [username], async (err, rows) => {
      if (err) {
        console.error("❌ DB error register:", err);
        return res.status(500).json({ ok: false, message: "Lỗi database." });
      }
      if (rows.length > 0) {
        return res.status(409).json({ ok: false, message: "Username đã tồn tại." });
      }

      const hashed = await bcrypt.hash(password, 10);

      db.query(
        "INSERT INTO users (username, password, total_score, personal_score, created_at) VALUES (?, ?, 0, 0, ?)",
        [username, hashed, nowISO()],
        (err2, result) => {
          if (err2) {
            console.error("❌ DB error insert user:", err2);
            return res.status(500).json({ ok: false, message: "Lỗi tạo user." });
          }

          return res.json({
            ok: true,
            message: "Đăng ký thành công.",
            user: { id: result.insertId, username },
          });
        }
      );
    });
  } catch (e) {
    console.error("❌ register error:", e);
    return res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const username = safeStr(req.body.username);
    const password = safeStr(req.body.password);

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: "Thiếu username/password." });
    }

    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, rows) => {
      if (err) {
        console.error("❌ DB error login:", err);
        return res.status(500).json({ ok: false, message: "Lỗi database." });
      }
      if (rows.length === 0) {
        return res.status(401).json({ ok: false, message: "Sai tài khoản hoặc mật khẩu." });
      }

      const user = rows[0];
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(401).json({ ok: false, message: "Sai tài khoản hoặc mật khẩu." });
      }

      return res.json({
        ok: true,
        message: "Đăng nhập thành công.",
        user: {
          id: user.id,
          username: user.username,
          total_score: user.total_score || 0,
          personal_score: user.personal_score || 0,
        },
      });
    });
  } catch (e) {
    console.error("❌ login error:", e);
    return res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

/**************************************************
 * END MEMBER 3
 **************************************************/

/**************************************************
 * COMMON - ROUTE GIAO DIỆN 
 * Chỉ chỉnh khi cần mapping trang, static...
 **************************************************/

// ---------- ROUTE GIAO DIỆN ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

/**************************************************
 * BEGIN MEMBER 1 - SOCKET.IO EVENTS
 * Phạm vi: socket.on(...) của multiplayer + emit room state
 **************************************************/

// ---------- SOCKET.IO ----------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // Client gửi user info sau login
  socket.on("registerOnline", (payload) => {
    const userId = payload?.userId;
    const username = payload?.username;
    if (userId) {
      onlineUsers[userId] = socket.id;
      socket.data.userId = userId;
      socket.data.username = username || "User";
    }
  });

  // --- MULTIPLAYER: create room ---
  socket.on("createRoom", (payload = {}) => {
    const userId = payload.userId || socket.data.userId;
    const username = payload.username || socket.data.username;

    if (!userId) {
      return socket.emit("gameError", "Bạn chưa đăng nhập.");
    }

    const room = createRoom({
      userId,
      username,
      socketId: socket.id,
    });

    socket.join(room.id);

    socket.emit("roomCreated", toPublicRoom(room));
    broadcastRoomUpdate(room);
  });

  // --- MULTIPLAYER: join room ---
  socket.on("joinRoom", (payload = {}) => {
    const roomId = typeof payload === "string" ? payload : payload.roomId;
    const userId = payload.userId || socket.data.userId;
    const username = payload.username || socket.data.username;

    if (!roomId) return socket.emit("gameError", "Thiếu roomId.");
    const room = getRoomById(roomId);
    if (!room) return socket.emit("gameError", "Phòng không tồn tại.");

    if (room.state !== "waiting") {
      return socket.emit("gameError", "Phòng đang chơi, không thể tham gia.");
    }

    if (!userId) return socket.emit("gameError", "Bạn chưa đăng nhập.");

    const ok = addPlayerToRoom(room, {
      userId,
      username,
      socketId: socket.id,
    });

    if (!ok) {
      // nếu đã có trong room -> vẫn join lại socket room
      socket.join(room.id);
      broadcastRoomUpdate(room);
      return socket.emit("roomJoined", toPublicRoom(room));
    }

    socket.join(room.id);
    socket.emit("roomJoined", toPublicRoom(room));
    broadcastRoomUpdate(room);
  });

  socket.on("leaveRoom", (payload = {}) => {
    const roomId = typeof payload === "string" ? payload : payload.roomId;
    if (!roomId) return;

    const room = getRoomById(roomId);
    if (!room) return;

    socket.leave(room.id);
    removePlayerFromRoom(room, socket.id);
    setRoomOwnerIfNeeded(room);

    if (room.players.length === 0) {
      removeRoom(room.id);
      return;
    }

    broadcastRoomUpdate(room);
  });

  // đổi chế độ chơi / bộ từ (chỉ owner)
  socket.on("updateRoomSettings", (payload = {}) => {
    const roomId = payload.roomId;
    const room = getRoomById(roomId);
    if (!room) return socket.emit("gameError", "Phòng không tồn tại.");

    const me = getPlayerInRoom(room, socket.id);
    if (!me) return socket.emit("gameError", "Bạn không ở trong phòng.");

    if (me.userId !== room.ownerId) {
      return socket.emit("gameError", "Bạn không phải chủ phòng.");
    }

    if (payload.mode) {
      const m = safeStr(payload.mode);
      if (m === "normal" || m === "reverse") room.mode = m;
    }

    if (payload.wordPack) {
      room.wordPack = sanitizePackName(payload.wordPack);
    }

    broadcastRoomUpdate(room);
  });

  // start game (chỉ owner)
  socket.on("startGame", (payload = {}) => {
    const roomId = typeof payload === "string" ? payload : payload.roomId;
    if (!roomId) return socket.emit("gameError", "Thiếu thông tin phòng.");

    const room = getRoomById(roomId);
    if (!room) return socket.emit("gameError", "Phòng không tồn tại.");

    const me = getPlayerInRoom(room, socket.id);
    if (!me) return socket.emit("gameError", "Bạn không ở trong phòng.");

    if (me.userId !== room.ownerId) {
      return socket.emit("gameError", "Bạn không phải chủ phòng.");
    }

    if (room.players.length < 2) {
      return socket.emit("gameError", "Cần ít nhất 2 người để bắt đầu.");
    }

    if (room.state === "playing") return;

    room.state = "playing";
    room.round = 0;

    // reset score
    room.players.forEach((p) => (p.score = 0));

    broadcastRoomUpdate(room);

    startMultiplayerRound(room);
  });

  socket.on("submitAnswer", (payload = {}) => {
    const roomId = payload.roomId;
    const answer = safeStr(payload.answer);

    if (!roomId) return;
    const room = getRoomById(roomId);
    if (!room) return;

    if (room.state !== "playing") return;

    const me = getPlayerInRoom(room, socket.id);
    if (!me) return;

    const current = room.currentWord;
    if (!current) return;

    const correctWord = current.word;
    const gained = checkAnswerAndScore(room.mode, correctWord, answer);

    if (gained > 0) {
      me.score = (me.score || 0) + gained;

      io.to(room.id).emit("answerResult", {
        ok: true,
        by: { userId: me.userId, username: me.username },
        gained,
        correctWord,
      });

      // sang round mới ngay
      clearInterval(room.timer);
      room.timer = null;
      startMultiplayerRound(room);
    } else {
      socket.emit("answerResult", {
        ok: false,
        by: { userId: me.userId, username: me.username },
        gained: 0,
        correctWord,
      });
    }

    broadcastRoomUpdate(room);
  });

  socket.on("endGame", (payload = {}) => {
    const roomId = typeof payload === "string" ? payload : payload.roomId;
    if (!roomId) return;

    const room = getRoomById(roomId);
    if (!room) return;

    const me = getPlayerInRoom(room, socket.id);
    if (!me) return;

    if (me.userId !== room.ownerId) {
      return socket.emit("gameError", "Bạn không phải chủ phòng.");
    }

    finishMultiplayerGame(room);
  });

  function startMultiplayerRound(room) {
    room.round += 1;

    if (room.round > room.maxRounds) {
      return finishMultiplayerGame(room);
    }

    const w = getRandomWordFromPack(room.wordPack);
    if (!w) {
      return finishMultiplayerGame(room, "Không có từ trong bộ từ.");
    }

    room.currentWord = w;
    room.timeLeft = ROUND_TIME;

    io.to(room.id).emit("roundStart", {
      round: room.round,
      maxRounds: room.maxRounds,
      word: w.word,
      meaning: w.meaning,
      image: w.image,
      mode: room.mode,
      time: room.timeLeft,
    });

    // timer
    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
      room.timeLeft -= 1;
      io.to(room.id).emit("timerUpdate", { time: room.timeLeft });

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.timer = null;

        io.to(room.id).emit("roundTimeout", {
          round: room.round,
          correctWord: room.currentWord?.word,
        });

        // sang round mới
        startMultiplayerRound(room);
      }
    }, 1000);

    broadcastRoomUpdate(room);
  }

  function finishMultiplayerGame(room, reason) {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.state = "ended";

    // sort winners
    const sorted = [...room.players].sort((a, b) => (b.score || 0) - (a.score || 0));
    const winner = sorted[0];

    io.to(room.id).emit("gameEnded", {
      roomId: room.id,
      reason: reason || null,
      winner: winner ? { userId: winner.userId, username: winner.username, score: winner.score || 0 } : null,
      leaderboard: sorted.map((p) => ({
        userId: p.userId,
        username: p.username,
        score: p.score || 0,
      })),
    });

    // cập nhật total_score cho tất cả
    sorted.forEach((p) => {
      if (!p.userId) return;
      const gained = p.score || 0;
      if (gained <= 0) return;

      db.query(
        "UPDATE users SET total_score = total_score + ? WHERE id = ?",
        [gained, p.userId],
        (err) => {
          if (err) console.error("Lỗi cập nhật total_score multi:", err);
        }
      );
    });

    broadcastRoomUpdate(room);
  }

  function checkAnswerAndScore(mode, correctWord, answer) {
    if (!answer) return 0;
    const a = answer.toLowerCase();
    const c = correctWord.toLowerCase();

    if (mode === "reverse") {
      // reverse mode: nhập meaning? (tuỳ game), ở đây giữ đơn giản: vẫn check word
      return a === c ? 10 : 0;
    }
    return a === c ? 10 : 0;
  }

  // Lưu score single-player kiểu local, socket.data.score
  socket.data.score = socket.data.score || 0;

  // nhận điểm chơi đơn cuối game (client gửi)
  socket.on("singlePlayerScore", (payload = {}) => {
    const gainedScore = Number(payload.score) || 0;
    const game = payload.game || {};
    const username = payload.username || socket.data.username;

    // update personal score / total score
    let finalTotalScore = game.score || 0;
    let finalUserScore = socket.data.score || 0;

    // Single player -> cộng total_score + personal_score
    if (gainedScore > 0 && socket.data.userId) {
      db.query(
        "UPDATE users SET total_score = total_score + ?, personal_score = personal_score + ? WHERE id = ?",
        [gainedScore, gainedScore, socket.data.userId],
        (err) => {
          if (err) console.error("Lỗi cập nhật điểm single:", err);
        }
      );
      socket.data.score = (socket.data.score || 0) + gainedScore;
      finalUserScore = socket.data.score;
    }

    socket.emit("singlePlayerScoreSaved", {
      ok: true,
      username,
      totalScore: finalTotalScore,
      personalScore: finalUserScore,
    });
  });

/**************************************************
 * END MEMBER 1 *
 **************************************************/
