function fetchApi(endpoint, method, body) {
  const url = endpoint;
  const config = {
    method: method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  };

  return fetch(url, config)
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Server responded with ${response.status}: ${
            errorText || "Unknown error"
          }`
        );
      }
      return response.json();
    })
    .catch((error) => {
      console.error(
        `Lỗi mạng hoặc server không phản hồi cho ${endpoint}:`,
        error
      );
      throw new Error("Lỗi mạng hoặc server không phản hồi.");
    });
}

function handleSuccessfulAuth(user) {
  localStorage.setItem("currentUser", JSON.stringify(user));
  window.location.href = "/index.html";
}

async function handleLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value.trim();
  const messageElement = document.getElementById("authMessage");
  messageElement.textContent = "";

  if (!username || !password) {
    messageElement.textContent =
      "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.";
    return;
  }

  try {
    const data = await fetchApi("/api/login", "POST", { username, password });
    if (data.success) {
      handleSuccessfulAuth(data.user);
    } else {
      messageElement.textContent = data.message || "Đăng nhập thất bại!";
    }
  } catch (error) {
    console.error("Lỗi đăng nhập:", error);
    messageElement.textContent =
      error.message || "Có lỗi xảy ra khi đăng nhập!";
  }
}

async function handleRegister() {
  const username = document.getElementById("registerUsername")?.value.trim();
  const password = document.getElementById("registerPassword")?.value.trim();
  const confirmPassword = document
    .getElementById("registerConfirmPassword")
    ?.value.trim();
  const displayName = document
    .getElementById("registerDisplayName")
    ?.value.trim();
  const messageElement = document.getElementById("regMessage");
  messageElement.textContent = "";

  if (!username || !password || !displayName || !confirmPassword) {
    messageElement.textContent = "Vui lòng nhập đầy đủ thông tin.";
    return;
  }
  if (password.length < 6) {
    messageElement.textContent = "Mật khẩu phải có ít nhất 6 ký tự.";
    return;
  }
  if (password !== confirmPassword) {
    messageElement.textContent = "Mật khẩu xác nhận không khớp!";
    return;
  }

  try {
    const data = await fetchApi("/api/register", "POST", {
      username,
      password,
      displayName,
    });
    if (data.success) {
      alert("Đăng ký thành công! Bạn sẽ được chuyển hướng để đăng nhập.");
      window.location.href = `/login.html?username=${encodeURIComponent(
        username
      )}`;
    } else {
      messageElement.textContent = data.message || "Đăng ký thất bại!";
    }
  } catch (error) {
    console.error("Lỗi đăng ký:", error);
    messageElement.textContent = error.message || "Có lỗi xảy ra khi đăng ký!";
  }
}

function setupAuthListeners() {
  document.getElementById("loginBtn")?.addEventListener("click", handleLogin);
  document
    .getElementById("loginPassword")
    ?.addEventListener("keyup", function (event) {
      if (event.key === "Enter") handleLogin();
    });

  document
    .getElementById("registerBtn")
    ?.addEventListener("click", handleRegister);
  document
    .getElementById("registerConfirmPassword")
    ?.addEventListener("keyup", function (event) {
      if (event.key === "Enter") handleRegister();
    });
}

document.addEventListener("DOMContentLoaded", function () {
  setupAuthListeners();
  const urlParams = new URLSearchParams(window.location.search);
  const usernameFromRegister = urlParams.get("username");
  const loginUsernameInput = document.getElementById("loginUsername");

  if (usernameFromRegister && loginUsernameInput) {
    loginUsernameInput.value = usernameFromRegister;
    document.getElementById("loginPassword")?.focus();
  }
});
/**************************************************
 * COMMON - WORD PACK SELECT 
 **************************************************/
function populateWordPackSelects(elementId) {
  const select = document.getElementById(elementId);
  if (!select) return;

  const selectedValue = select.value;
  select.innerHTML = "";

  if (Object.keys(globalWordPacks).length === 0) {
    select.innerHTML = "<option value=''>Đang tải bộ từ...</option>";
    return;
  }

  for (const key in globalWordPacks) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = globalWordPacks[key].name;
    select.appendChild(option);
  }

  if (select.querySelector(`option[value="${selectedValue}"]`)) {
    select.value = selectedValue;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

/**************************************************
 * BEGIN MEMBER VU - SOCKET CONNECT + GAME FLOW UI/LOGIC
 **************************************************/
function initSocketConnection() {
  socket = io();

  socket.on("connect", () => {
    console.log("Connected to server:", socket.id);
    socket.emit("clientReady", currentUser);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected from server");
    if (currentRoom) {
      alert("Mất kết nối với phòng chơi. Quay lại trang chủ.");
      setCurrentRoom(null);
    }
    setIsSinglePlayer(false);
    switchScreen("lobbyScreen");
  });

  socket.on("lobbyData", (data) => {
    console.log("Nhận được lobbyData (bộ từ)");

    globalWordPacks = data.wordPacks;

    populateWordPackSelects("singlePlayerWordPackSelect");

    if (currentRoom) {
      console.log("Đang ở trong phòng, cập nhật lại bộ từ phòng...");
      populateWordPackSelects("roomWordPack");
      const roomPackSelect = document.getElementById("roomWordPack");
      if (
        roomPackSelect.querySelector(`option[value="${currentRoom.wordPack}"]`)
      ) {
        roomPackSelect.value = currentRoom.wordPack;
      }
    }
  });