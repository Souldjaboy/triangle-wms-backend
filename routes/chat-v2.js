const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

module.exports = function createChatV2Router({
  pool,
  authenticateToken,
  createNotification,
  getEffectiveCompanyId,
  requirePermission
}) {
  const router = express.Router();

  router.use(
    "/chat",
    authenticateToken,
    requirePermission("chat", "view")
  );

  const uploadDir = path.join(
    __dirname,
    "..",
    "uploads",
    "chat"
  );

  fs.mkdirSync(uploadDir, {
    recursive: true
  });

  const blockedExtensions = new Set([
    ".exe",
    ".msi",
    ".com",
    ".bat",
    ".cmd",
    ".ps1",
    ".sh",
    ".php",
    ".js",
    ".mjs",
    ".cjs",
    ".html",
    ".htm",
    ".svg",
    ".jar",
    ".apk",
    ".dll",
    ".scr",
    ".vbs"
  ]);

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      cb(null, uploadDir);
    },

    filename(req, file, cb) {
      const ext = path
        .extname(file.originalname || "")
        .toLowerCase();

      const base = path
        .basename(
          file.originalname || "fichier",
          ext
        )
        .normalize("NFKD")
        .replace(/[^\w.-]+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 100);

      cb(
        null,
        `${Date.now()}-${crypto
          .randomBytes(8)
          .toString("hex")}-${base || "fichier"}${ext}`
      );
    }
  });

  const chatUpload = multer({
    storage,

    limits: {
      fileSize: 200 * 1024 * 1024
    },

    fileFilter(req, file, cb) {
      const ext = path
        .extname(file.originalname || "")
        .toLowerCase();

      if (blockedExtensions.has(ext)) {
        return cb(
          new Error(
            "Ce type de fichier est interdit pour des raisons de sécurité."
          )
        );
      }

      cb(null, true);
    }
  });

  function companyOf(req) {
    const id =
      Number(
        typeof getEffectiveCompanyId === "function"
          ? getEffectiveCompanyId(req)
          : req.user?.company_id
      ) ||
      Number(req.user?.company_id || 0);

    return id || null;
  }

  async function conversationForUser(
    conversationId,
    req
  ) {
    const companyId = companyOf(req);

    if (!companyId) return null;

    const { rows } = await pool.query(
      `
      SELECT
        c.*,
        cp.role AS my_role
      FROM conversations c
      JOIN conversation_participants cp
        ON cp.conversation_id=c.id
      WHERE c.id=$1
        AND c.company_id=$2
        AND cp.user_id=$3
      LIMIT 1
      `,
      [
        Number(conversationId),
        companyId,
        Number(req.user.id)
      ]
    );

    return rows[0] || null;
  }

  async function participantsOf(
    conversationId,
    companyId
  ) {
    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.fullname,
        u.email,
        u.role,
        u.profile_image_url,
        cp.role AS conversation_role,
        cp.created_at
      FROM conversation_participants cp
      JOIN conversations c
        ON c.id=cp.conversation_id
      JOIN users u
        ON u.id=cp.user_id
      WHERE cp.conversation_id=$1
        AND c.company_id=$2
      ORDER BY
        CASE
          WHEN cp.role='admin' THEN 0
          ELSE 1
        END,
        u.fullname ASC
      `,
      [
        conversationId,
        companyId
      ]
    );

    return rows;
  }

  async function userBelongsToCompany(
    userId,
    companyId
  ) {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM users u
      WHERE u.id=$1
        AND COALESCE(u.is_active,true)=true
        AND (
          u.company_id=$2

          OR u.is_super_admin=true

          OR EXISTS (
            SELECT 1
            FROM user_company_access uca
            WHERE uca.user_id=u.id
              AND uca.company_id=$2
          )
        )
      LIMIT 1
      `,
      [
        userId,
        companyId
      ]
    );

    return rows.length > 0;
  }

  async function notifyConversation({
    conversationId,
    companyId,
    senderId,
    title,
    message,
    type
  }) {
    const participants =
      await participantsOf(
        conversationId,
        companyId
      );

    for (const p of participants) {
      if (
        Number(p.id) ===
        Number(senderId)
      ) {
        continue;
      }

      await createNotification({
        user_id: p.id,
        title,
        message,
        type,
        company_id: companyId,
        priority:
          type === "chat_call"
            ? "high"
            : "normal",
        related_entity_type:
          "conversation",
        related_entity_id:
          conversationId,
        action_url:
          `/chat?conversation=${conversationId}`,
        created_by: senderId,
        assigned_to: p.id
      });
    }
  }


  /*
  ========================================
  UTILISATEURS DISPONIBLES POUR CHAT
  ========================================
  */

  router.get(
    "/chat/users",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        if (!companyId) {
          return res.status(400).json({
            error:
              "Sélectionnez une société."
          });
        }

        const { rows } =
          await pool.query(
            `
            SELECT DISTINCT
              u.id,
              u.fullname,
              u.email,
              u.role,
              u.profile_image_url,
              u.company_id
            FROM users u
            LEFT JOIN user_company_access uca
              ON uca.user_id=u.id
             AND uca.company_id=$1
            WHERE COALESCE(u.is_active,true)=true
              AND (
                u.company_id=$1
                OR uca.company_id=$1
                OR u.is_super_admin=true
              )
            ORDER BY u.fullname ASC
            `,
            [companyId]
          );

        res.json(rows);
      } catch (error) {
        console.error(
          "CHAT_V2_USERS",
          error
        );

        res.status(500).json({
          error:
            "Erreur récupération utilisateurs."
        });
      }
    }
  );


  /*
  ========================================
  LISTE CONVERSATIONS
  ========================================
  */

  router.get(
    "/chat/conversations/:userId",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        if (!companyId) {
          return res.status(400).json({
            error:
              "Société active introuvable."
          });
        }

        const userId =
          Number(req.user.id);

        const { rows } =
          await pool.query(
            `
            SELECT
              c.*,

              COUNT(
                DISTINCT cp_all.user_id
              )::int
                AS participant_count,

              STRING_AGG(
                DISTINCT CASE
                  WHEN cp_all.user_id <> $1
                  THEN u.fullname
                END,
                ', '
              )
                AS participant_names

            FROM conversations c

            JOIN conversation_participants mine
              ON mine.conversation_id=c.id
             AND mine.user_id=$1

            LEFT JOIN conversation_participants cp_all
              ON cp_all.conversation_id=c.id

            LEFT JOIN users u
              ON u.id=cp_all.user_id

            WHERE c.company_id=$2

            GROUP BY c.id

            ORDER BY c.id DESC
            `,
            [
              userId,
              companyId
            ]
          );

        res.json(rows);
      } catch (error) {
        console.error(
          "CHAT_V2_CONVERSATIONS",
          error
        );

        res.status(500).json({
          error:
            "Erreur lecture conversations."
        });
      }
    }
  );


  /*
  ========================================
  CREATION PRIVE / GROUPE
  ========================================
  */

  router.post(
    "/chat/conversations",
    authenticateToken,
    async (req, res) => {
      const client =
        await pool.connect();

      try {
        const companyId =
          companyOf(req);

        const creatorId =
          Number(req.user.id);

        const type =
          req.body?.type === "group"
            ? "group"
            : "private";

        const participantIds =
          Array.from(
            new Set(
              [
                creatorId,
                ...(
                  Array.isArray(
                    req.body?.participants
                  )
                    ? req.body.participants
                    : []
                )
              ]
                .map(Number)
                .filter(
                  (id) =>
                    Number.isInteger(id) &&
                    id > 0
                )
            )
          );

        if (!companyId) {
          return res.status(400).json({
            error:
              "Société active introuvable."
          });
        }

        if (
          type === "private" &&
          participantIds.length !== 2
        ) {
          return res.status(400).json({
            error:
              "Une conversation privée doit contenir exactement deux personnes."
          });
        }

        if (
          type === "group" &&
          participantIds.length < 2
        ) {
          return res.status(400).json({
            error:
              "Ajoutez au moins une autre personne."
          });
        }

        for (
          const id of participantIds
        ) {
          const allowed =
            await userBelongsToCompany(
              id,
              companyId
            );

          if (!allowed) {
            return res.status(400).json({
              error:
                "Un participant n'appartient pas à la société active."
            });
          }
        }

        /*
        Eviter doublon discussion privée
        */

        if (type === "private") {
          const otherId =
            participantIds.find(
              (id) =>
                id !== creatorId
            );

          const existing =
            await pool.query(
              `
              SELECT c.*
              FROM conversations c
              WHERE c.company_id=$1
                AND c.type='private'

                AND EXISTS (
                  SELECT 1
                  FROM conversation_participants a
                  WHERE a.conversation_id=c.id
                    AND a.user_id=$2
                )

                AND EXISTS (
                  SELECT 1
                  FROM conversation_participants b
                  WHERE b.conversation_id=c.id
                    AND b.user_id=$3
                )

                AND (
                  SELECT COUNT(*)
                  FROM conversation_participants x
                  WHERE x.conversation_id=c.id
                )=2

              LIMIT 1
              `,
              [
                companyId,
                creatorId,
                otherId
              ]
            );

          if (
            existing.rows.length
          ) {
            return res.json(
              existing.rows[0]
            );
          }
        }

        let title =
          String(
            req.body?.title || ""
          ).trim();

        if (
          !title &&
          type === "group"
        ) {
          title = "Nouveau groupe";
        }

        if (
          !title &&
          type === "private"
        ) {
          const otherId =
            participantIds.find(
              (id) =>
                id !== creatorId
            );

          const other =
            await pool.query(
              `
              SELECT fullname
              FROM users
              WHERE id=$1
              `,
              [otherId]
            );

          title =
            other.rows[0]
              ?.fullname ||
            "Conversation privée";
        }

        await client.query("BEGIN");

        const { rows } =
          await client.query(
            `
            INSERT INTO conversations
            (
              title,
              type,
              created_by,
              company_id,
              description
            )
            VALUES
            ($1,$2,$3,$4,$5)
            RETURNING *
            `,
            [
              title,
              type,
              creatorId,
              companyId,
              String(
                req.body
                  ?.description || ""
              )
            ]
          );

        const conversation =
          rows[0];

        for (
          const userId
          of participantIds
        ) {
          await client.query(
            `
            INSERT INTO conversation_participants
            (
              conversation_id,
              user_id,
              role
            )
            VALUES
            ($1,$2,$3)

            ON CONFLICT
              (conversation_id,user_id)

            DO UPDATE SET
              role=EXCLUDED.role
            `,
            [
              conversation.id,
              userId,
              userId === creatorId
                ? "admin"
                : "member"
            ]
          );
        }

        await client.query(
          "COMMIT"
        );

        res.status(201).json(
          conversation
        );
      } catch (error) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        console.error(
          "CHAT_V2_CREATE",
          error
        );

        res.status(500).json({
          error:
            "Erreur création conversation."
        });
      } finally {
        client.release();
      }
    }
  );


  /*
  ========================================
  MEMBRES
  ========================================
  */

  router.get(
    "/chat/conversations/:id/participants",
    authenticateToken,
    async (req, res) => {
      try {
        const conversation =
          await conversationForUser(
            req.params.id,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        res.json(
          await participantsOf(
            conversation.id,
            companyOf(req)
          )
        );
      } catch (error) {
        console.error(
          "CHAT_V2_MEMBERS",
          error
        );

        res.status(500).json({
          error:
            "Erreur lecture membres."
        });
      }
    }
  );


  router.post(
    "/chat/conversations/:id/participants",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        const conversation =
          await conversationForUser(
            req.params.id,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        if (
          conversation.type !==
          "group"
        ) {
          return res.status(409).json({
            error:
              "Cette conversation n'est pas un groupe."
          });
        }

        if (
          conversation.my_role !==
            "admin" &&
          Number(
            conversation.created_by
          ) !==
            Number(req.user.id)
        ) {
          return res.status(403).json({
            error:
              "Seul un administrateur du groupe peut ajouter des membres."
          });
        }

        const userId =
          Number(
            req.body?.user_id
          );

        if (
          !userId ||
          !(
            await userBelongsToCompany(
              userId,
              companyId
            )
          )
        ) {
          return res.status(400).json({
            error:
              "Utilisateur invalide."
          });
        }

        await pool.query(
          `
          INSERT INTO conversation_participants
          (
            conversation_id,
            user_id,
            role
          )
          VALUES
          ($1,$2,'member')

          ON CONFLICT
            (conversation_id,user_id)

          DO NOTHING
          `,
          [
            conversation.id,
            userId
          ]
        );

        res.json({
          success: true,

          participants:
            await participantsOf(
              conversation.id,
              companyId
            )
        });
      } catch (error) {
        console.error(
          "CHAT_V2_ADD_MEMBER",
          error
        );

        res.status(500).json({
          error:
            "Erreur ajout membre."
        });
      }
    }
  );


  router.delete(
    "/chat/conversations/:id/participants/:userId",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        const conversation =
          await conversationForUser(
            req.params.id,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        if (
          conversation.type !==
          "group"
        ) {
          return res.status(409).json({
            error:
              "Cette conversation n'est pas un groupe."
          });
        }

        if (
          conversation.my_role !==
            "admin" &&
          Number(
            conversation.created_by
          ) !==
            Number(req.user.id)
        ) {
          return res.status(403).json({
            error:
              "Seul un administrateur peut retirer un membre."
          });
        }

        const userId =
          Number(
            req.params.userId
          );

        if (
          userId ===
          Number(
            conversation.created_by
          )
        ) {
          return res.status(409).json({
            error:
              "Le créateur du groupe ne peut pas être retiré."
          });
        }

        await pool.query(
          `
          DELETE FROM conversation_participants
          WHERE conversation_id=$1
            AND user_id=$2
          `,
          [
            conversation.id,
            userId
          ]
        );

        res.json({
          success: true,

          participants:
            await participantsOf(
              conversation.id,
              companyId
            )
        });
      } catch (error) {
        console.error(
          "CHAT_V2_REMOVE_MEMBER",
          error
        );

        res.status(500).json({
          error:
            "Erreur retrait membre."
        });
      }
    }
  );


  /*
  ========================================
  MESSAGES
  ========================================
  */

  router.get(
    "/chat/messages/:conversationId",
    authenticateToken,
    async (req, res) => {
      try {
        const conversation =
          await conversationForUser(
            req.params
              .conversationId,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Vous n'êtes pas membre de cette conversation."
          });
        }

        const { rows } =
          await pool.query(
            `
            SELECT
              m.*,
              u.fullname
                AS sender_name,
              u.role
                AS sender_role,
              u.profile_image_url

            FROM messages m

            LEFT JOIN users u
              ON u.id=m.sender_id

            WHERE
              m.conversation_id=$1
              AND m.company_id=$2

            ORDER BY m.id ASC
            `,
            [
              conversation.id,
              companyOf(req)
            ]
          );

        res.json(rows);
      } catch (error) {
        console.error(
          "CHAT_V2_MESSAGES",
          error
        );

        res.status(500).json({
          error:
            "Erreur lecture messages."
        });
      }
    }
  );


  router.post(
    "/chat/messages",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        const conversation =
          await conversationForUser(
            req.body
              ?.conversation_id,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        const senderId =
          Number(req.user.id);

        const messageType =
          String(
            req.body
              ?.message_type ||
            "text"
          ).slice(0, 40);

        const content =
          String(
            req.body
              ?.content || ""
          );

        const fileUrl =
          String(
            req.body
              ?.file_url || ""
          );

        const documentUrl =
          String(
            req.body
              ?.document_url || ""
          );

        if (
          !content.trim() &&
          !fileUrl &&
          !documentUrl
        ) {
          return res.status(400).json({
            error:
              "Message vide."
          });
        }

        const { rows } =
          await pool.query(
            `
            INSERT INTO messages
            (
              conversation_id,
              sender_id,
              receiver_id,
              content,
              message_type,
              audio_url,
              company_id,

              file_url,
              file_name,
              file_size,
              file_mime,

              document_url,
              document_title,

              metadata
            )
            VALUES
            (
              $1,
              $2,
              NULL,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              $12,
              $13::jsonb
            )
            RETURNING *
            `,
            [
              conversation.id,
              senderId,
              content,
              messageType,

              messageType ===
              "audio"
                ? fileUrl
                : "",

              companyId,

              fileUrl,

              String(
                req.body
                  ?.file_name || ""
              ),

              Number(
                req.body
                  ?.file_size || 0
              ),

              String(
                req.body
                  ?.file_mime || ""
              ),

              documentUrl,

              String(
                req.body
                  ?.document_title ||
                ""
              ),

              JSON.stringify(
                req.body
                  ?.metadata || {}
              )
            ]
          );

        let title =
          "Nouveau message";

        if (
          messageType === "audio"
        ) {
          title =
            "Nouveau message vocal";
        }

        if (
          [
            "file",
            "image",
            "video"
          ].includes(messageType)
        ) {
          title =
            "Nouveau fichier";
        }

        if (
          messageType ===
          "document"
        ) {
          title =
            "Document Triangle partagé";
        }

        await notifyConversation({
          conversationId:
            conversation.id,

          companyId,

          senderId,

          title,

          message:
            conversation.type ===
            "group"
              ? `${
                  req.user
                    .fullname ||
                  req.user.email ||
                  "Un membre"
                } a envoyé un message dans « ${conversation.title} ».`
              : "Vous avez reçu un nouveau message interne.",

          type:
            messageType ===
            "audio"
              ? "chat_audio"
              : "chat_message"
        });

        res.status(201).json(
          rows[0]
        );
      } catch (error) {
        console.error(
          "CHAT_V2_SEND",
          error
        );

        res.status(500).json({
          error:
            "Erreur envoi message."
        });
      }
    }
  );


  /*
  ========================================
  UPLOAD FICHIERS / PHOTO / AUDIO / VIDEO
  ========================================
  */

  router.post(
    "/chat/upload-file",
    authenticateToken,
    chatUpload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({
            error:
              "Aucun fichier reçu."
          });
        }

        const conversation =
          await conversationForUser(
            req.body
              ?.conversation_id,
            req
          );

        if (!conversation) {
          fs.unlink(
            req.file.path,
            () => {}
          );

          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        const mime =
          String(
            req.file.mimetype ||
            "application/octet-stream"
          );

        let messageType =
          "file";

        if (
          mime.startsWith("image/")
        ) {
          messageType = "image";
        } else if (
          mime.startsWith("video/")
        ) {
          messageType = "video";
        } else if (
          mime.startsWith("audio/")
        ) {
          messageType = "audio";
        }

        res.status(201).json({
          file_url:
            `/uploads/chat/${encodeURIComponent(
              req.file.filename
            )}`,

          file_name:
            req.file.originalname,

          file_size:
            req.file.size,

          file_mime:
            mime,

          message_type:
            messageType
        });
      } catch (error) {
        console.error(
          "CHAT_V2_UPLOAD",
          error
        );

        res.status(500).json({
          error:
            error?.message ||
            "Erreur upload fichier."
        });
      }
    }
  );


  /*
  ========================================
  APPEL AUDIO / VIDEO
  ========================================
  */

  router.post(
    "/chat/calls",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          companyOf(req);

        const conversation =
          await conversationForUser(
            req.body
              ?.conversation_id,
            req
          );

        if (!conversation) {
          return res.status(403).json({
            error:
              "Conversation inaccessible."
          });
        }

        const mode =
          req.body?.mode ===
          "video"
            ? "video"
            : "audio";

        const roomName =
          `triangle-${companyId}-${conversation.id}-${Date.now()}-${crypto
            .randomBytes(4)
            .toString("hex")}`;

        const baseUrl =
          `https://meet.jit.si/${roomName}`;

        const meetingUrl =
          mode === "audio"
            ? `${baseUrl}#config.prejoinPageEnabled=false&config.startWithVideoMuted=true`
            : `${baseUrl}#config.prejoinPageEnabled=false`;

        const { rows } =
          await pool.query(
            `
            INSERT INTO meetings
            (
              title,
              room_name,
              meeting_url,
              conversation_id,
              created_by,
              company_id,
              mode
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *
            `,
            [
              `${
                mode === "audio"
                  ? "Appel vocal"
                  : "Appel vidéo"
              } — ${conversation.title}`,

              roomName,
              meetingUrl,
              conversation.id,
              Number(req.user.id),
              companyId,
              mode
            ]
          );

        const meeting =
          rows[0];

        const participants =
          await participantsOf(
            conversation.id,
            companyId
          );

        for (
          const p
          of participants
        ) {
          await pool.query(
            `
            INSERT INTO meeting_participants
            (
              meeting_id,
              user_id
            )
            VALUES ($1,$2)

            ON CONFLICT
              (meeting_id,user_id)

            DO NOTHING
            `,
            [
              meeting.id,
              p.id
            ]
          );
        }

        await pool.query(
          `
          INSERT INTO messages
          (
            conversation_id,
            sender_id,
            content,
            message_type,
            company_id,
            document_url,
            document_title,
            metadata
          )
          VALUES
          (
            $1,
            $2,
            $3,
            'call',
            $4,
            $5,
            $6,
            $7::jsonb
          )
          `,
          [
            conversation.id,
            Number(req.user.id),

            mode === "audio"
              ? "📞 Appel vocal lancé"
              : "📹 Appel vidéo lancé",

            companyId,

            meetingUrl,

            mode === "audio"
              ? "Rejoindre l'appel vocal"
              : "Rejoindre l'appel vidéo",

            JSON.stringify({
              meeting_id:
                meeting.id,
              mode
            })
          ]
        );

        await notifyConversation({
          conversationId:
            conversation.id,

          companyId,

          senderId:
            Number(req.user.id),

          title:
            mode === "audio"
              ? "📞 Appel vocal entrant"
              : "📹 Appel vidéo entrant",

          message:
            `${
              req.user.fullname ||
              req.user.email ||
              "Un utilisateur"
            } vous appelle dans « ${conversation.title} ».`,

          type:
            "chat_call"
        });

        res.status(201).json({
          ...meeting,

          participants:
            participants.map(
              (p) => p.id
            )
        });
      } catch (error) {
        console.error(
          "CHAT_V2_CALL",
          error
        );

        res.status(500).json({
          error:
            "Erreur création appel."
        });
      }
    }
  );

  return router;
};
