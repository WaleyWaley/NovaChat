-- =============================================================================
-- NovaChat — MySQL 初始化建表脚本
--
-- 使用: docker-compose 启动时自动执行, 或手动:
--   mysql -u root -p novachat < scripts/docker/init.sql
-- =============================================================================

CREATE DATABASE IF NOT EXISTS novachat
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE novachat;

-- ============================= 用户表 =========================================

CREATE TABLE IF NOT EXISTS users (
    -- 主键: Snowflake 生成的全局唯一 ID
    user_id       BIGINT UNSIGNED  NOT NULL PRIMARY KEY,

    -- 登录凭证
    username      VARCHAR(32)      NOT NULL,
    -- 相比于简单的 MD5，这能有效抵抗彩虹表和暴力破解。配合迭代次数和盐值
    password_hash VARCHAR(256)     NOT NULL COMMENT 'PBKDF2-SHA256 格式: $pbkdf2-sha256$<iter>$<salt>$<hash>',

    -- 个人资料
    first_name    VARCHAR(64)      NOT NULL,
    last_name     VARCHAR(64)      NOT NULL DEFAULT '',
    bio           VARCHAR(256)     NOT NULL DEFAULT '',
    avatar_photo_id VARCHAR(128)   NOT NULL DEFAULT '',
    phone         VARCHAR(20)      NOT NULL DEFAULT '',

    -- 状态
    is_deleted    TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '软删除标记',

    -- 时间戳 (毫秒)
    created_at    BIGINT UNSIGNED  NOT NULL,
    updated_at    BIGINT UNSIGNED  NOT NULL,
    username_changed_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '最近一次修改 username 的时间',

    -- 索引
    UNIQUE INDEX idx_username (username),
    INDEX idx_created_at (created_at),
    INDEX idx_first_name (first_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='NovaChat 用户表';

-- ============================= 用户消息表 =====================================
-- (Phase 2.4 message-service 使用, 在此先行定义)

CREATE TABLE IF NOT EXISTS messages (
    -- 主键: Snowflake 全局唯一消息 ID
    message_id    BIGINT UNSIGNED  NOT NULL PRIMARY KEY,

    -- 会话路由
    from_user_id  BIGINT UNSIGNED  NOT NULL,
    to_peer_type  TINYINT          NOT NULL COMMENT '1=user, 2=chat, 3=channel',
    to_peer_id    BIGINT UNSIGNED  NOT NULL,

    -- 消息内容
    msg_type      TINYINT          NOT NULL DEFAULT 0 COMMENT 'enum MessageType',
    text          VARCHAR(4096)    NOT NULL DEFAULT '',
    entities      MEDIUMBLOB       NULL     COMMENT '序列化的 MessageEntity 列表',
    media_info    MEDIUMBLOB       NULL     COMMENT '序列化的 FileReference',

    -- 回复 / 转发
    reply_to_msg_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    fwd_from_msg_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    fwd_from_peer_type TINYINT      NOT NULL DEFAULT 0,
    fwd_from_peer_id   BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- 标记位 (使用位图编码, 节省空间)
    flags         INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'bit0:pinned bit1:silent bit2:edited bit3:ttl',

    -- 自毁计时 (秒)
    ttl_seconds   INT UNSIGNED     NOT NULL DEFAULT 0,

    -- 时间
    created_at    BIGINT UNSIGNED  NOT NULL,
    edited_at     BIGINT UNSIGNED  NOT NULL DEFAULT 0,

    -- 索引: 按时间线查询消息 (Timeline 模型)
    INDEX idx_peer_timeline (to_peer_type, to_peer_id, created_at DESC),
    INDEX idx_from_user (from_user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='NovaChat 消息表';
