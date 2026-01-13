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

let wordPacks = {};
let rooms = [];
let singlePlayerGames = new Map(); // key: socketId -> { ...gameState }
let onlineUsers = new Map(); // key: userId -> socketId
let isDatabaseLoaded = false;

// =======================================================
// ✅ FIX ẢNH/BỘ TỪ: hỗ trợ image string | array | images[]
// =======================================================
function pickImageFromWord(wordObj) {
  if (!wordObj || typeof wordObj !== "object") return null;

  // hỗ trợ cả image và images
  const candidate = wordObj.image ?? wordObj.images ?? null;

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

  return null;
}

function toPublicImageUrl(img) {
  if (!img || typeof img !== "string") return null;
  const s = img.trim();
  if (!s) return null;

  // ảnh online
  if (s.startsWith("http://") || s.startsWith("https://")) return s;

  // ảnh local
  if (s.startsWith("/")) return s;
  return `/${s}`;
}

// ---------- ĐỌC TỪ VỰNG TỪ JSON ----------
function loadWordsFromDatabase() {
  try {
    const generalData = fs.readFileSync(
      path.join(__dirname, "words.json"),
      "utf8"
    );
    const animalsData = fs.readFileSync(
      path.join(__dirname, "words_animals.json"),
      "utf8"
    );
    const jobsData = fs.readFileSync(
      path.join(__dirname, "words_jobs.json"),
      "utf8"
    );

    // pack mới
    const transportationData = fs.readFileSync(
      path.join(__dirname, "word_gtpt.json"),
      "utf8"
    );
    const sportsEntertainmentData = fs.readFileSync(
      path.join(__dirname, "word_ttgt.json"),
      "utf8"
    );
    const placesFoodDrinksData = fs.readFileSync(
      path.join(__dirname, "word_dd&at.json"),
      "utf8"
    );

    const generalJson = JSON.parse(generalData);

    // Tách category từ words.json nếu có
    const categoryNameMap = {
      places_food_drinks: "Địa điểm, đồ ăn & thức uống",
      transportation: "Phương tiện giao thông",
      sports_entertainment: "Thể thao & giải trí",
      objects_animals_jobs: "Đồ vật, động vật & nghề nghiệp",
    };

    const derivedPacksFromWordsJson = {};
    let generalWordsFlattened = [];

    if (Array.isArray(generalJson)) {
      // trường hợp words.json là mảng
      generalWordsFlattened = generalJson;
    } else if (generalJson && typeof generalJson === "object") {
      // lấy tất cả key có value là array
      for (const [key, val] of Object.entries(generalJson)) {
        if (Array.isArray(val)) {
          derivedPacksFromWordsJson[key] = {
            name: categoryNameMap[key] || key,
            words: val,
          };
          generalWordsFlattened = generalWordsFlattened.concat(val);
        }
      }
    }

    wordPacks = {
      general: {
        name: "Bộ từ chung",
        words: generalWordsFlattened,
      },

      ...derivedPacksFromWordsJson,

      // Các pack từ file riêng
      animals: { name: "Động vật", words: JSON.parse(animalsData) },
      jobs: { name: "Nghề nghiệp", words: JSON.parse(jobsData) },

      transportation: {
        name: "Phương tiện giao thông",
        words: JSON.parse(transportationData),
      },
      sports_entertainment: {
        name: "Thể thao & giải trí",
        words: JSON.parse(sportsEntertainmentData),
      },
      places_food_drinks: {
        name: "Địa điểm, đồ ăn",
        words: JSON.parse(placesFoodDrinksData),
      },
    };

    // Tính totalWords an toàn
    const totalWords = Object.values(wordPacks).reduce((sum, pack) => {
      if (pack && Array.isArray(pack.words)) return sum + pack.words.length;
      return sum;
    }, 0);

    if (totalWords === 0) {
      console.error("❌ LỖI: Tất cả các file JSON đều rỗng!");
      isDatabaseLoaded = false;
      return;
    }

    console.log(
      `✅ Loaded ${totalWords} words from ${Object.keys(wordPacks).length} packs.`
    );
    isDatabaseLoaded = true;
  } catch (err) {
    console.error("❌ LỖI NGHIÊM TRỌNG: Không thể đọc file .json.", err);
    isDatabaseLoaded = false;
  }
}

loadWordsFromDatabase();

// ---------- HÀM TIỆN ÍCH ----------
function maskWord(word, guessedLetters) {
  if (!guessedLetters || guessedLetters.length === 0) {
    return word
      .split("")
      .map((ch) => (ch === " " ? " " : "_"))
      .join("");
  }

  const guessedSet = new Set(guessedLetters.map((c) => c.toLowerCase()));
  return word
    .split("")
    .map((char) => {
      if (char === " ") return " ";
      return guessedSet.has(char.toLowerCase()) ? char : "_";
    })
    .join("");
}

function getNewWord(wordPackKey) {
  const pack = wordPacks[wordPackKey];
  if (!pack || !Array.isArray(pack.words) || pack.words.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(Math.random() * pack.words.length);
  const raw = pack.words[randomIndex]; // { word, meaning, image } hoặc { images: [...] }

  // ✅ normalize để chắc chắn image luôn là string/null
  if (!raw || typeof raw !== "object") return null;

  const picked = pickImageFromWord(raw);
  return {
    ...raw,
    image: picked, // string hoặc null (có thể là "images/a.jpg" hoặc "http...")
  };
}

function normalizeText(str) {
  if (!str) return "";
  return str
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getRoomForClient(room) {
  if (!room) return null;
  const { gameInterval, roundEndTimer, ...rest } = room;
  return rest;
}

function sendLobbyData(socket) {
  if (!isDatabaseLoaded) {
    socket.emit("gameError", "Chưa load được từ vựng, vui lòng F5 lại.");
    return;
  }
  socket.emit("lobbyData", {
    wordPacks: Object.keys(wordPacks).reduce((acc, key) => {
      acc[key] = { name: wordPacks[key].name };
      return acc;
    }, {}),
  });
}

// ---------- GAME ĐA NGƯỜI (ROOM) ----------
function startRound(room) {
  if (!room) return;

  const wordData = getNewWord(room.wordPack);
  if (!wordData) {
    io.to(room.id).emit(
      "gameError",
      "Không tải được từ vựng, vui lòng thử lại."
    );
    return;
  }

  let correctAnswer, hintWord;
  if (room.gameMode === "reverse") {
    correctAnswer = wordData.meaning;
    hintWord = wordData.word;
  } else {
    correctAnswer = wordData.word;
    hintWord = wordData.meaning;
  }

  room.correctAnswer = correctAnswer;
  room.hintWord = hintWord;

  // ✅ FIX: không gọi startsWith trên non-string
  const img = wordData.image; // đã normalize string|null
  room.hintImage = toPublicImageUrl(img);

  room.guessedLetters = [];
  room.status = "playing";

  room.currentRound = room.currentRound || 1;

  io.to(room.id).emit("roundUpdate", {
    round: room.currentRound,
    maxRounds: room.maxRounds,
    maskedWord: maskWord(room.correctAnswer, room.guessedLetters),
    hintWord: room.hintWord,
    hintImage: room.hintImage,
    room: getRoomForClient(room),
  });

  room.timeLeft = ROUND_TIME;
  io.to(room.id).emit("timerUpdate", { time: room.timeLeft });

  if (room.gameInterval) clearInterval(room.gameInterval);
  room.gameInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit("timerUpdate", { time: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearInterval(room.gameInterval);
      room.gameInterval = null;

      io.to(room.id).emit("roundEnd", {
        word: room.correctAnswer,
        room: getRoomForClient(room),
      });

      if (room.currentRound >= room.maxRounds) {
        setTimeout(() => endGame(room), 3000);
      } else {
        setTimeout(() => {
          room.currentRound++;
          startRound(room);
        }, 3000);
      }
    }
  }, 1000);
}

function endGame(room) {
  if (room.roundEndTimer) clearTimeout(room.roundEndTimer);
  let winnerPlayer = null;

  room.players.forEach((p) => {
    if (p.score > 0 && p.id) {
      // Đấu phòng -> cộng total_score + duo_score
      db.query(
        "UPDATE users SET total_score = total_score + ?, duo_score = duo_score + ? WHERE id = ?",
        [p.score, p.score, p.id],
        (err) => {
          if (err) console.error("Lỗi cập nhật tổng điểm (room):", err);
        }
      );
    }
    if (!winnerPlayer || p.score > winnerPlayer.score) {
      winnerPlayer = p;
    }
  });

  let finalUserScore = 0;
  if (winnerPlayer) {
    const userInRoom = room.players.find((p) => p.id === winnerPlayer.id);
    if (userInRoom) {
      finalUserScore =
        (userInRoom.total_score || 0) + (userInRoom.score || 0);
    }
  }

  io.to(room.id).emit("gameEnd", {
    message: "TRÒ CHƠI KẾT THÚC!",
    ranking: room.players,
    finalUserScore: finalUserScore,
  });

  rooms = rooms.filter((r) => r.id !== room.id);
}

// ---------- API AUTH ----------
app.post("/api/register", async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res
      .status(400)
      .json({ success: false, message: "Thiếu thông tin." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.query(
      "INSERT INTO users (username, password, name, total_score, personal_score, duo_score) VALUES (?, ?, ?, 0, 0, 0)",
      [username, hashedPassword, displayName],
      (err) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY") {
            return res
              .status(400)
              .json({ success: false, message: "Tên đăng nhập đã tồn tại." });
          }
          console.error("Lỗi DB khi đăng ký:", err);
          return res
            .status(500)
            .json({ success: false, message: "Lỗi Server DB." });
        }
        res.json({ success: true, message: "Đăng ký thành công." });
      }
    );
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi Server nội bộ." });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Thiếu thông tin." });
  }
  db.query(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, results) => {
      if (err) {
        console.error(err);
        return res
          .status(500)
          .json({ success: false, message: "Lỗi Server DB." });
      }
      const user = results[0];
      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "Tên đăng nhập không tồn tại." });
      }
      try {
        const match = await bcrypt.compare(password, user.password);
        if (match || password === user.password) {
          res.json({
            success: true,
            user: {
              id: user.id,
              username: user.username,
              name: user.name,
              score: user.personal_score ?? 0,
            },
          });
        } else {
          res
            .status(401)
            .json({ success: false, message: "Mật khẩu không đúng." });
        }
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .json({ success: false, message: "Lỗi Server nội bộ." });
      }
    }
  );
});

// ---------- ROUTE GIAO DIỆN ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/register.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- SOCKET.IO ----------
io.on("connection", (socket) => {
  console.log("Client kết nối:", socket.id);

  // Khi client gửi thông tin user sau khi login
  socket.on("clientReady", (user) => {
    socket.data.userId = user.id;
    socket.data.username = user.username;
    socket.data.displayName = user.name;
    socket.data.score = user.score || 0;
    if (user.id) {
      onlineUsers.set(user.id, socket.id);
    }
    sendLobbyData(socket);
  });

  // TẠO PHÒNG
  socket.on("createRoom", () => {
    if (!socket.data.userId) {
      return socket.emit("gameError", "Bạn cần đăng nhập để tạo phòng.");
    }

    let shortId;
    do {
      shortId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.some((r) => r.shortId === shortId));

    const newRoom = {
      id: uuidv4(),
      shortId,
      name: `${socket.data.displayName}'s Room`,
      hostId: socket.data.userId,
      hostSocketId: socket.id,
      players: [],
      status: "waiting",
      currentRound: 1,
      maxRounds: MAX_ROUNDS,
      gameMode: "normal",
      wordPack: "general",
      correctAnswer: null,
      hintWord: null,
      hintImage: null,
      guessedLetters: [],
      timeLeft: ROUND_TIME,
      gameInterval: null,
      roundEndTimer: null,
    };

    rooms.push(newRoom);
    handleJoinRoom(socket, { roomId: newRoom.id });
  });

  // HÀM JOIN PHÒNG DÙNG LẠI
  function handleJoinRoom(socket, { roomId }) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) {
      return socket.emit("joinError", "Phòng không tồn tại.");
    }
    if (room.status === "playing") {
      return socket.emit("joinError", "Phòng đang chơi, không thể tham gia.");
    }

    // Nếu đã ở phòng khác thì rời phòng cũ
    const oldRoom = rooms.find((r) =>
      r.players.some((p) => p.socketId === socket.id)
    );
    if (oldRoom) {
      oldRoom.players = oldRoom.players.filter(
        (p) => p.socketId !== socket.id
      );
      io.to(oldRoom.id).emit("roomUpdate", getRoomForClient(oldRoom));
    }

    socket.join(room.id);

    let player = room.players.find((p) => p.id === socket.data.userId);
    if (!player) {
      player = {
        id: socket.data.userId,
        username: socket.data.username,
        name: socket.data.displayName,
        socketId: socket.id,
        score: 0,
        total_score: socket.data.score || 0,
      };
      room.players.push(player);
    } else {
      player.socketId = socket.id;
    }

    if (room.hostId === socket.data.userId) {
      room.hostSocketId = socket.id;
    }

    io.to(room.id).emit("roomUpdate", getRoomForClient(room));
  }

  socket.on("joinRoom", ({ roomId }) => handleJoinRoom(socket, { roomId }));

  socket.on("joinRoomById", ({ searchInput }) => {
    const trimmed = (searchInput || "").trim();
    let room = null;

    if (/^\d{6}$/.test(trimmed)) {
      room = rooms.find((r) => r.shortId === trimmed);
    } else {
      room = rooms.find((r) => r.id === trimmed);
    }

    if (!room) {
      return socket.emit("joinError", "Không tìm thấy phòng với mã này.");
    }
    handleJoinRoom(socket, { roomId: room.id });
  });

  // CẬP NHẬT CÀI ĐẶT PHÒNG (host)
  socket.on("updateRoomSettings", ({ roomId, gameMode, wordPack }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    const isHost =
      room.hostId === socket.data.userId || room.hostSocketId === socket.id;

    if (!isHost) {
      return socket.emit(
        "gameError",
        "Chỉ chủ phòng mới được thay đổi cài đặt."
      );
    }

    if (gameMode === "normal" || gameMode === "reverse") {
      room.gameMode = gameMode;
    }
    if (wordPack && wordPacks[wordPack]) {
      room.wordPack = wordPack;
    }

    io.to(room.id).emit("roomUpdate", getRoomForClient(room));
  });

  // BẮT ĐẦU GAME ĐA NGƯỜI (KHÔNG CHECK CHỦ PHÒNG, EMIT ĐÚNG FORMAT)
  socket.on("startGame", (data = {}) => {
    const { roomId } = data || {};

    let room = null;

    // 1) Nếu client có gửi roomId thì thử dùng nó trước
    if (roomId) {
      room = rooms.find(
        (r) => r.id === roomId || r.shortId === roomId.toString()
      );
    }

    // 2) Nếu vẫn chưa tìm thấy, suy ra phòng dựa trên socket hiện tại đang ở đâu
    if (!room) {
      room = rooms.find((r) => r.players.some((p) => p.socketId === socket.id));
    }

    // 3) Nếu vẫn không có, nghĩa là socket này không ở phòng nào
    if (!room) {
      return socket.emit("gameError", "Bạn chưa ở trong phòng nào.");
    }

    // Không kiểm tra chủ phòng nữa – ai trong phòng bấm cũng được
    if (room.players.length < 1) {
      return socket.emit(
        "gameError",
        "Cần ít nhất 1 người chơi để bắt đầu game."
      );
    }

    room.currentRound = 1;
    room.players.forEach((p) => {
      p.score = 0;
    });

    io.to(room.id).emit("gameStart", { room: getRoomForClient(room) });
    startRound(room);
  });

  // NGƯỜI CHƠI ĐOÁN TỪ TRONG PHÒNG
  socket.on("makeGuess", ({ roomId, guess }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return;

    const cleanGuess = normalizeText(guess);
    const cleanAnswer = normalizeText(room.correctAnswer);

    if (!cleanGuess) {
      return socket.emit("guessResult", {
        isCorrect: false,
        message: "Bạn chưa nhập gì.",
      });
    }

    // ĐOÁN TỪ
    if (cleanGuess.length > 1) {
      if (cleanGuess === cleanAnswer) {
        if (room.gameInterval) {
          clearInterval(room.gameInterval);
          room.gameInterval = null;
        }

        const points = 100 + room.timeLeft;
        player.score += points;

        // ✅ FIX BUG: game.score không tồn tại -> dùng player.score
        socket.emit("guessResult", {
          isCorrect: true,
          message: `Chính xác! +${points} điểm.`,
          maskedWord: room.correctAnswer,
          currentScore: player.score,
        });

        io.to(room.id).emit("roundEnd", {
          word: room.correctAnswer,
          room: getRoomForClient(room),
        });

        if (room.currentRound >= room.maxRounds) {
          setTimeout(() => endGame(room), 3000);
        } else {
          setTimeout(() => {
            room.currentRound++;
            startRound(room);
          }, 3000);
        }
      } else {
        player.score -= 30;
        socket.emit("guessResult", {
          isCorrect: false,
          message: "Đoán sai từ, -30 điểm.",
          currentScore: player.score,
        });
      }
      return;
    }

    // (nếu bạn có logic đoán ký tự 1 chữ ở đây thì để nguyên / bổ sung sau)
  });

  // RỜI PHÒNG (thoát phòng ở chế độ đấu phòng)
  const handleLeaveRoom = ({ roomId, isDisconnecting }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    room.players = room.players.filter((p) => p.socketId !== socket.id);
    socket.leave(room.id);

    if (room.players.length === 0) {
      if (room.gameInterval) clearInterval(room.gameInterval);
      rooms = rooms.filter((r) => r.id !== room.id);
      return;
    }

    if (room.hostId === socket.data.userId || room.hostSocketId === socket.id) {
      const newHost = room.players[0];
      room.hostId = newHost.id;
      room.hostSocketId = newHost.socketId;
    }

    io.to(room.id).emit("roomUpdate", getRoomForClient(room));
  };

  socket.on("leaveRoom", ({ roomId }) =>
    handleLeaveRoom({ roomId, isDisconnecting: false })
  );

  // Thoát game chế độ đấu phòng
  socket.on("quitMultiplayerGame", ({ roomId }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    handleLeaveRoom({ roomId: room.id, isDisconnecting: false });
    socket.emit("gameQuit", {
      message: "Bạn đã thoát khỏi phòng chơi.",
    });
  });

  // ---------- BẢNG XẾP HẠNG ----------
  socket.on("getRanking", () => {
    db.query(
      "SELECT name, personal_score AS score FROM users ORDER BY personal_score DESC LIMIT 10",
      (err, results) => {
        if (err) return console.error("Lỗi lấy BXH:", err);
        socket.emit("sendRanking", results);
      }
    );
  });

  socket.on("getPersonalRanking", () => {
    db.query(
      "SELECT name, personal_score AS score FROM users ORDER BY personal_score DESC LIMIT 10",
      (err, results) => {
        if (err) return console.error("Lỗi lấy BXH cá nhân:", err);
        socket.emit("sendPersonalRanking", results);
      }
    );
  });

  socket.on("getDuoRanking", () => {
    db.query(
      "SELECT name, duo_score AS score FROM users ORDER BY duo_score DESC LIMIT 10",
      (err, results) => {
        if (err) return console.error("Lỗi lấy BXH đấu đôi:", err);
        socket.emit("sendDuoRanking", results);
      }
    );
  });

  // Thống kê cá nhân chi tiết
  socket.on("getMyPersonalStats", () => {
    const userId = socket.data.userId;
    if (!userId) {
      return socket.emit("myPersonalStatsError", "Bạn chưa đăng nhập.");
    }

    db.query(
      "SELECT id, name, total_score, personal_score, duo_score FROM users WHERE id = ?",
      [userId],
      (err, results) => {
        if (err) {
          console.error("Lỗi lấy thông tin cá nhân:", err);
          return socket.emit(
            "myPersonalStatsError",
            "Không lấy được thông tin cá nhân."
          );
        }
        if (!results.length) {
          return socket.emit(
            "myPersonalStatsError",
            "Không tìm thấy tài khoản."
          );
        }

        const user = results[0];

        db.query(
          "SELECT COUNT(*) + 1 AS personal_rank FROM users WHERE personal_score > ?",
          [user.personal_score],
          (err1, r1) => {
            if (err1) {
              console.error("Lỗi tính rank cá nhân:", err1);
              return socket.emit(
                "myPersonalStatsError",
                "Không tính được rank cá nhân."
              );
            }

            db.query(
              "SELECT COUNT(*) + 1 AS duo_rank FROM users WHERE duo_score > ?",
              [user.duo_score],
              (err2, r2) => {
                if (err2) {
                  console.error("Lỗi tính rank đấu đôi:", err2);
                  return socket.emit(
                    "myPersonalStatsError",
                    "Không tính được rank đấu đôi."
                  );
                }

                socket.emit("myPersonalStats", {
                  name: user.name,
                  total_score: user.total_score,
                  personal_score: user.personal_score,
                  duo_score: user.duo_score,
                  personal_rank: r1[0].personal_rank,
                  duo_rank: r2[0].duo_rank,
                });
              }
            );
          }
        );
      }
    );
  });

  // ---------- SINGLE PLAYER ----------
  function endSinglePlayerGame(socketId, game, isCorrect) {
    if (!game) return;

    if (game.gameInterval) clearInterval(game.gameInterval);
    singlePlayerGames.delete(socketId);

    const gainedScore = game.score || 0;
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

    if (!isCorrect) {
      socket.emit("roundEnd", {
        word: game.correctAnswer,
        room: { players: [] },
      });
    }

    const message = isCorrect
      ? "Bạn đã hoàn thành trò chơi 1 người!"
      : "Trò chơi kết thúc!";
    setTimeout(() => {
      socket.emit("gameEnd", {
        message: message,
        ranking: [],
        finalUserScore: finalUserScore,
        gameScore: gainedScore,
      });
    }, 3000);
  }

  function startSinglePlayerRound(socketId, gameMode, wordPack, currentRound) {
    const game = singlePlayerGames.get(socketId) || {};
    const newWordData = getNewWord(wordPack);
    if (!newWordData) {
      return socket.emit("gameError", "Lỗi: Không thể tải từ vựng.");
    }

    let correctAnswer, hintWord;
    if (gameMode === "reverse") {
      correctAnswer = newWordData.meaning;
      hintWord = newWordData.word;
    } else {
      correctAnswer = newWordData.word;
      hintWord = newWordData.meaning;
    }

    game.correctAnswer = correctAnswer;
    game.hintWord = hintWord;

    // ✅ FIX: image array cũng chạy ngon
    game.hintImage = toPublicImageUrl(newWordData.image);

    game.guessedLetters = [];
    game.gameMode = gameMode;
    game.wordPack = wordPack;
    game.currentRound = currentRound;
    game.timeLeft = ROUND_TIME;

    if (currentRound === 1 || typeof game.score !== "number") {
      game.score = 0;
    }

    if (game.gameInterval) clearInterval(game.gameInterval);
    game.gameInterval = setInterval(() => {
      game.timeLeft--;
      socket.emit("timerUpdate", { time: game.timeLeft });

      if (game.timeLeft <= 0) {
        endSinglePlayerGame(socket.id, game, false);
      }
    }, 1000);

    singlePlayerGames.set(socketId, game);

    socket.emit("roundUpdate", {
      round: game.currentRound,
      maxRounds: "∞",
      maskedWord: maskWord(game.correctAnswer, game.guessedLetters),
      hintWord: game.hintWord,
      hintImage: game.hintImage,
      room: { players: [] },
      currentScore: game.score || 0,
    });
    socket.emit("timerUpdate", { time: game.timeLeft });
  }

  // ✅ FIX: tránh gán lại const destructuring
  socket.on("startSinglePlayer", (payload = {}) => {
    let { gameMode, wordPack } = payload;

    if (!wordPack || !wordPacks[wordPack]) {
      wordPack = Object.keys(wordPacks)[0] || "general";
    }
    if (gameMode !== "normal" && gameMode !== "reverse") {
      gameMode = "normal";
    }
    startSinglePlayerRound(socket.id, gameMode, wordPack, 1);
  });

  socket.on("makeSinglePlayerGuess", ({ guess }) => {
    const game = singlePlayerGames.get(socket.id);
    if (!game) return;

    const cleanGuess = normalizeText(guess);
    const cleanAnswer = normalizeText(game.correctAnswer);

    if (!cleanGuess) {
      return socket.emit("guessResult", {
        isCorrect: false,
        message: "Bạn chưa nhập gì.",
      });
    }

    // ĐOÁN TỪ
    if (cleanGuess.length > 1) {
      if (cleanGuess === cleanAnswer) {
        const points = 100 + game.timeLeft;
        game.score = (game.score || 0) + points;

        clearInterval(game.gameInterval);

        socket.emit("guessResult", {
          isCorrect: true,
          message: `Chính xác! +${points} điểm. Sang vòng tiếp theo...`,
          maskedWord: game.correctAnswer,
          currentScore: game.score,
        });

        setTimeout(() => {
          startSinglePlayerRound(
            socket.id,
            game.gameMode,
            game.wordPack,
            game.currentRound + 1
          );
        }, 3000);
      } else {
        const newScore = (game.score || 0) - 30;
        game.score = newScore < 0 ? 0 : newScore;

        socket.emit("guessResult", {
          isCorrect: false,
          message: "Đoán sai từ, -30 điểm.",
          currentScore: game.score,
        });
      }
      return;
    }
  });

  // Thoát game 1 người
  socket.on("quitSinglePlayerGame", () => {
    const game = singlePlayerGames.get(socket.id);
    if (!game) {
      return socket.emit("gameEnd", {
        message: "Bạn đã thoát chế độ 1 người.",
        ranking: [],
        finalUserScore: socket.data.score || 0,
      });
    }
    endSinglePlayerGame(socket.id, game, false);
  });

  // ---------- MỜI NGƯỜI CHƠI ----------
  socket.on("invitePlayer", ({ username, roomId }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) {
      return socket.emit("inviteMessage", {
        success: false,
        message: "Phòng không tồn tại.",
      });
    }
    if (!username) {
      return socket.emit("inviteMessage", {
        success: false,
        message: "Vui lòng nhập tên người chơi.",
      });
    }

    db.query(
      "SELECT id, name FROM users WHERE username = ?",
      [username],
      (err, results) => {
        if (err) {
          console.error("Lỗi DB khi mời:", err);
          return socket.emit("inviteMessage", {
            success: false,
            message: "Lỗi hệ thống khi gửi lời mời.",
          });
        }
        if (!results.length) {
          return socket.emit("inviteMessage", {
            success: false,
            message: "Không tìm thấy người chơi với tên này.",
          });
        }

        const target = results[0];
        const targetSocketId = onlineUsers.get(target.id);
        if (!targetSocketId) {
          return socket.emit("inviteMessage", {
            success: false,
            message: "Người chơi hiện không online.",
          });
        }

        io.to(targetSocketId).emit("receiveInvite", {
          roomId: room.id,
          roomName: room.name,
          inviterName: socket.data.displayName,
        });

        socket.emit("inviteMessage", {
          success: true,
          message: "Đã gửi lời mời tới " + target.name,
        });
      }
    );
  });

  // ---------- NGẮT KẾT NỐI ----------
  socket.on("disconnect", () => {
    console.log("Client ngắt kết nối:", socket.id);

    singlePlayerGames.delete(socket.id);

    if (socket.data.userId) {
      onlineUsers.delete(socket.data.userId);
    }

    const room = rooms.find((r) =>
      r.players.some((p) => p.socketId === socket.id)
    );
    if (room) {
      handleLeaveRoom({ roomId: room.id, isDisconnecting: true });
    }
  });
});

// ---------- KHỞI ĐỘNG SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
