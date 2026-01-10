DROP DATABASE IF EXISTS `wordgame`;

-- Tạo database
CREATE DATABASE IF NOT EXISTS `wordgame`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `wordgame`;

-- =========================================================
-- BẢNG Người dùng 
-- =========================================================
-- Cấu trúc:
--   id              : khoá chính
--   username        : tài khoản đăng nhập (unique)
--   password        : mật khẩu (plain text hoặc hash bcrypt tuỳ code)
--   name            : tên hiển thị trong game
--   total_score     : tổng điểm chung (giữ lại cho tương thích)
--   personal_score  : điểm dùng cho Bảng thành tích cá nhân
--   duo_score       : điểm dùng cho Bảng xếp hạng đấu đôi
--   created_at      : thời gian tạo tài khoản
-- =========================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `total_score` INT NOT NULL DEFAULT 0,
  `personal_score` INT NOT NULL DEFAULT 0,
  `duo_score` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- (TUỲ CHỌN) THÊM MỘT VÀI TÀI KHOẢN TEST
--  Mật khẩu đang là PLAIN TEXT (ví dụ: 123456),
--  code Node đang kiểm tra:
--     bcrypt.compare(password, user.password) OR password === user.password
--  nên vẫn đăng nhập được.
