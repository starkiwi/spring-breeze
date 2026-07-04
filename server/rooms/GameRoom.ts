import { Room, Client } from "colyseus";
import { GameState, Player, Collectible, GridCell, PlayerColor, CollectibleType, CollectibleColor, CollectibleOrientation, Enemy, EnemyPersonality } from "../schema/GameState";
import { CollectibleFactory } from "../collectibles";
import { CollectibleSpawnConfig, COLLECTIBLE_PROPERTIES } from "../config/CollectibleSpawnConfig";
import { LevelSpec, parseUnrealExport } from "../config/LevelSpec";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { LiveKitService } from "../services/LiveKitService";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class SeededRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed |= 0;
    this.seed = this.seed + 0x6D2B79F5 | 0;
    let t = Math.imul(this.seed ^ this.seed >>> 15, 1 | this.seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

interface MoveMessage {
  direction: "up" | "down" | "left" | "right";
  seq?: number;
  targetColor?: "RED" | "GREEN" | "BLUE";
}

interface PingMessage {
  x: number;
  y: number;
}

interface DevPaintNodeMessage {
  x: number;
  y: number;
  color: string;
}

interface ClearBoardVote {
  sessionId: string;
  timestamp: number;
}

export class GameRoom extends Room<GameState> {
  maxClients = 10;
  private playerColors: PlayerColor[] = ["RED", "GREEN", "BLUE"];
  private assignedColors = new Set<PlayerColor>();
  private stageThresholds: number[];
  private readonly MAX_GRID_SIZE = 26; // Full grid size (stage 8)
  private readonly INITIAL_VISIBLE_WIDTH = 10; // Starting visible width (stage 1)
  private readonly INITIAL_VISIBLE_HEIGHT = 8; // Starting visible height (stage 1)
  private rng: SeededRNG;       // clue/collectible placement only
  private enemyRng: SeededRNG;  // enemy spawning & movement only
  private collectibleSpawnConfig: CollectibleSpawnConfig;
  private userIds: Map<string, string> = new Map(); // sessionId -> userId
  private userIdToColor: Map<string, "RED" | "GREEN" | "BLUE"> = new Map(); // userId -> color for reconnection
  private spectatorSessionIds = new Set<string>();
  private polarWindsSessionId: string | null = null;
  private gameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly GAME_DURATION = 30 * 60; // 30 minutes in seconds
  private clearBoardVotes: Map<string, ClearBoardVote> = new Map();
  private clearBoardVoteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly CLEAR_BOARD_VOTE_WINDOW = 5000; // 5 seconds
  private abandonGameVotes: Map<string, { sessionId: string; timestamp: number }> = new Map();
  private abandonGameVoteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ABANDON_GAME_VOTE_WINDOW = 10000; // 10 seconds
  private isSoloMode: boolean = false;
  private isDevMode: boolean = false;
  private livekitService: LiveKitService;
  private livekitRoomName: string | null = null;
  private enemyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ENEMY_MOVE_DELAY = 2000; // 2 seconds
  private levelSpec: LevelSpec | null = null;
  private lobbyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly LOBBY_TIMEOUT = 10 * 60 * 1000; // 10 minutes in ms
  private abandonTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly ABANDON_TIMEOUT = 2 * 60 * 1000; // 2 minutes in ms
  private isPlatformManaged: boolean = false;
  private replayEvents: Array<Record<string, unknown>> = [];
  private gameStartTime: number = 0;
  private sessionEndedInDb: boolean = false;
  private milestoneReportedTypes = new Set<string>();
  private pendingMilestoneRequests: Promise<void>[] = [];
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  onCreate(options: any) {
    console.log("GameRoom created with options:", options, "| Room ID:", this.roomId);

    this.isPlatformManaged = options.platformManaged || false;
    if (this.isPlatformManaged) {
      console.log("Room created in PLATFORM-MANAGED mode");
    }

    // Keep room alive for the full session duration (players can reconnect)
    this.autoDispose = false;

    // Start lobby timeout - dispose room if game doesn't start within timeout
    this.lobbyTimeout = setTimeout(() => {
      if (!this.state.gameStarted) {
        console.log("Lobby timeout - game never started, disposing room");
        this.disconnect();
      }
    }, this.LOBBY_TIMEOUT);

    // Initialize LiveKit service
    this.livekitService = new LiveKitService();

    // Load collectible spawn configuration first to get seed
    const configPath = join(__dirname, "../config/collectible-spawn.json");
    const configData = readFileSync(configPath, "utf-8");
    this.collectibleSpawnConfig = JSON.parse(configData);

    // Try to load level spec — from inline JSON (levelSpecJson) or file reference (levelSpec)
    if (options.levelSpecJson) {
      try {
        const parsed = typeof options.levelSpecJson === "string"
          ? JSON.parse(options.levelSpecJson)
          : options.levelSpecJson;
        if (parsed.clues_per_stage) {
          // Unreal export format
          this.levelSpec = parseUnrealExport(parsed);
        } else if (parsed.stages) {
          // Native LevelSpec format
          this.levelSpec = parsed as LevelSpec;
        } else if (parsed.collectible_spawn_rules?.length > 0) {
          // CollectibleSpawnConfig format — override the spawn config directly
          console.log("Loaded inline collectible spawn config override");
          this.collectibleSpawnConfig = parsed as CollectibleSpawnConfig;
        } else if (options.challengeNumber != null) {
          // TEMPORARY: DB has no spawn rules — load from Unreal-exported JSON file
          const paddedNumber = String(options.challengeNumber).padStart(3, "0");
          const jsonPath = join(__dirname, "../config/levels", `${paddedNumber}.json`);
          if (existsSync(jsonPath)) {
            const jsonData = readFileSync(jsonPath, "utf-8");
            const jsonParsed = JSON.parse(jsonData);
            if (jsonParsed.clues_per_stage) {
              this.levelSpec = parseUnrealExport(jsonParsed);
            } else if (jsonParsed.stages) {
              this.levelSpec = jsonParsed as LevelSpec;
            }
            if (this.levelSpec) {
              console.log(`[TEMP] Loaded level from ${paddedNumber}.json for challenge #${options.challengeNumber}`);
            }
          }
        }
        if (this.levelSpec) {
          console.log(`Loaded inline level spec with ${this.levelSpec.stages.length} stages`);
          if (this.levelSpec.custom_target_scores.length > 0) {
            this.collectibleSpawnConfig.custom_target_scores = this.levelSpec.custom_target_scores;
          }
          if (this.levelSpec.seed != null) {
            this.collectibleSpawnConfig.seed = this.levelSpec.seed;
          }
        }
      } catch (err) {
        console.warn("Failed to parse inline levelSpecJson:", err);
      }
    } else if (options.levelSpec) {
      const levelSpecPath = join(__dirname, "../config/levels", options.levelSpec);
      if (existsSync(levelSpecPath)) {
        const levelSpecData = readFileSync(levelSpecPath, "utf-8");
        const parsed = JSON.parse(levelSpecData);
        if (parsed.clues_per_stage) {
          this.levelSpec = parseUnrealExport(parsed);
        } else if (parsed.stages) {
          this.levelSpec = parsed as LevelSpec;
        }
        if (this.levelSpec) {
          console.log(`Loaded level spec: ${options.levelSpec} with ${this.levelSpec.stages.length} stages`);
          if (this.levelSpec.custom_target_scores.length > 0) {
            this.collectibleSpawnConfig.custom_target_scores = this.levelSpec.custom_target_scores;
          }
        }
      } else {
        console.warn(`Level spec not found: ${levelSpecPath}`);
      }
    }

    // Initialize RNG with seed from options, config, or random (dev mode)
    let seed: number;
    if (options.devMode) {
      seed = Math.floor(Math.random() * 2147483647);
      console.log("Dev mode: using random seed:", seed);
    } else if (options.seed) {
      seed = Number(options.seed) || (this.collectibleSpawnConfig.seed ?? Math.floor(Math.random() * 2147483647));
    } else {
      seed = this.collectibleSpawnConfig.seed ?? Math.floor(Math.random() * 2147483647);
    }
    this.rng = new SeededRNG(seed);
    this.enemyRng = new SeededRNG(seed ^ 0x45_4E_45_4D); // separate stream for enemy logic
    console.log("RNG initialized with seed:", seed);

    this.stageThresholds = this.collectibleSpawnConfig.custom_target_scores || [];
    console.log("Loaded collectible spawn config:", this.collectibleSpawnConfig);
    console.log("Stage thresholds:", this.stageThresholds);

    this.setState(new GameState());
    this.state.seed = seed;

    // Set initial visible grid size
    this.state.gridWidth = this.INITIAL_VISIBLE_WIDTH;
    this.state.gridHeight = this.INITIAL_VISIBLE_HEIGHT;

    // Set stage thresholds from config
    this.state.stageThresholds.push(...this.stageThresholds);

    // Initialize scores
    this.state.scores.set("RED", 0);
    this.state.scores.set("GREEN", 0);
    this.state.scores.set("BLUE", 0);

    console.log("Initial state set, scores initialized");

    // Handle player movement
    this.onMessage("move", (client, message: MoveMessage) => {
      if (this.state.countdown > 0) return;

      // In solo mode with targetColor, move the specified color's player
      let player: Player | undefined;
      let playerKey: string | undefined;

      if (this.isSoloMode && message.targetColor) {
        // Find the player with the requested color
        this.state.players.forEach((p, key) => {
          if (p.color === message.targetColor) {
            player = p;
            playerKey = key;
          }
        });
      } else {
        player = this.state.players.get(client.sessionId);
        playerKey = client.sessionId;
      }

      if (!player || !playerKey) return;

      const { direction } = message;
      let newX = player.x;
      let newY = player.y;

      // Calculate current visible bounds (centered on 26x26 grid)
      const center = Math.floor(this.MAX_GRID_SIZE / 2);
      const halfWidth = Math.floor(this.state.gridWidth / 2);
      const halfHeight = Math.floor(this.state.gridHeight / 2);
      const minX = center - halfWidth;
      const maxX = center + halfWidth - 1;
      const minY = center - halfHeight;
      const maxY = center + halfHeight - 1;

      switch (direction) {
        case "up":
          newY = Math.max(minY, player.y - 1);
          break;
        case "down":
          newY = Math.min(maxY, player.y + 1);
          break;
        case "left":
          newX = Math.max(minX, player.x - 1);
          break;
        case "right":
          newX = Math.min(maxX, player.x + 1);
          break;
      }

      // Check for collision with other players
      let isBlocked = false;
      this.state.players.forEach((otherPlayer, key) => {
        if (key !== playerKey &&
            otherPlayer.x === newX &&
            otherPlayer.y === newY) {
          isBlocked = true;
        }
      });

      // Only move and paint if not blocked
      if (!isBlocked) {
        player.x = newX;
        player.y = newY;

        // Paint the cell
        const cellKey = `${newX},${newY}`;
        let cell = this.state.gridColors.get(cellKey);
        if (!cell) {
          cell = new GridCell();
          this.state.gridColors.set(cellKey, cell);
        }
        cell.color = player.color;

        // Recalculate scores
        this.calculateScores();

        // Log move for replay
        this.logEvent({ e: "move", p: this.userIds.get(playerKey) || playerKey, d: direction, x: newX, y: newY });
      }

      // Send acknowledgment with final position (for client-side prediction reconciliation)
      if (message.seq !== undefined) {
        client.send("moveAck", { seq: message.seq, x: player.x, y: player.y });
      }
    });

    // Handle ping - just broadcast to all clients, don't store in state
    this.onMessage("ping", (client, message: PingMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      // Broadcast to all clients (excluding sender)
      this.broadcast("ping", {
        x: message.x,
        y: message.y,
        color: player.color
      }, { except: client });

      // Also send back to the sender
      client.send("ping", {
        x: message.x,
        y: message.y,
        color: player.color
      });

      // Log ping for replay
      this.logEvent({ e: "ping", p: this.userIds.get(client.sessionId) || client.sessionId, x: message.x, y: message.y });
    });

    // Handle dev mode stage up
    this.onMessage("devStageUp", (client) => {
      if (!this.isDevMode || !this.state.gameStarted) return;
      const nextStage = this.state.stage + 1;
      if (nextStage <= 8) {
        console.log(`[Dev Mode] Manual stage up from ${this.state.stage} to ${nextStage}. Score: ${this.state.totalScore}`);
        this.advanceToStage(nextStage);
      }
    });

    // Handle dev mode node painting
    this.onMessage("devPaintNode", (_client, message: DevPaintNodeMessage) => {
      if (!this.isDevMode || !this.state.gameStarted) return;

      const { x, y, color } = message;
      const cellKey = `${x},${y}`;

      // Get or create the grid cell
      let cell = this.state.gridColors.get(cellKey);
      if (!cell) {
        cell = new GridCell();
        this.state.gridColors.set(cellKey, cell);
      }

      // Set the color
      cell.color = color as any;

      // Recalculate scores
      this.calculateScores();

      console.log(`[Dev Mode] Painted node at (${x}, ${y}) with color ${color}`);
    });

    // Handle dev mode node clearing (right-click to make neutral)
    this.onMessage("devClearNode", (_client, message: { x: number; y: number }) => {
      if (!this.isDevMode || !this.state.gameStarted) return;

      const { x, y } = message;
      const cellKey = `${x},${y}`;
      this.state.gridColors.delete(cellKey);
      this.calculateScores();

      console.log(`[Dev Mode] Cleared node at (${x}, ${y})`);
    });

    // Handle clear board vote
    this.onMessage("clearBoard", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !this.state.gameStarted) return;

      // In solo mode, immediately clear the board
      if (this.isSoloMode) {
        this.executeClearBoard();
        return;
      }

      // Check if this player already voted
      if (this.clearBoardVotes.has(client.sessionId)) return;

      const isFirstVote = this.clearBoardVotes.size === 0;

      // Record this player's vote
      this.clearBoardVotes.set(client.sessionId, {
        sessionId: client.sessionId,
        timestamp: Date.now()
      });

      // If first vote, start the timer and notify all players
      if (isFirstVote) {
        this.startClearBoardVoteTimer();

        // Notify all players that voting has started
        this.broadcast("clearBoardVoteStarted", {
          initiatorColor: player.color,
          expiresAt: Date.now() + this.CLEAR_BOARD_VOTE_WINDOW
        });
      }

      // Broadcast updated vote count to all players
      this.broadcast("clearBoardVoteUpdate", {
        voterColor: player.color,
        voteCount: this.clearBoardVotes.size,
        requiredVotes: 3
      });

      // Check if all 3 players have voted
      if (this.clearBoardVotes.size === 3) {
        this.executeClearBoard();
      }
    });

    // Handle abandon game vote
    this.onMessage("abandonGame", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !this.state.gameStarted || this.state.isGameOver) return;

      // In solo mode, immediately abandon
      if (this.isSoloMode) {
        this.executeAbandonGame();
        return;
      }

      // Check if this player already voted
      if (this.abandonGameVotes.has(client.sessionId)) return;

      const isFirstVote = this.abandonGameVotes.size === 0;

      // Record this player's vote
      this.abandonGameVotes.set(client.sessionId, {
        sessionId: client.sessionId,
        timestamp: Date.now()
      });

      // Count active (non-spectator) players
      const activePlayers = [...this.state.players.keys()].filter(id => !this.spectatorSessionIds.has(id));
      const requiredVotes = activePlayers.length;

      // If first vote, start the timer and notify all players
      if (isFirstVote) {
        this.startAbandonGameVoteTimer();

        this.broadcast("abandonGameVoteStarted", {
          initiatorColor: player.color,
          expiresAt: Date.now() + this.ABANDON_GAME_VOTE_WINDOW
        });
      }

      // Broadcast updated vote count
      this.broadcast("abandonGameVoteUpdate", {
        voterColor: player.color,
        voteCount: this.abandonGameVotes.size,
        requiredVotes
      });

      // Check if all active players have voted
      if (this.abandonGameVotes.size >= requiredVotes) {
        this.executeAbandonGame();
      }
    });

    console.log("GameRoom created!");
  }

  async onJoin(client: Client, options: any) {
    console.log(`Client ${client.sessionId} joined! Current players: ${this.state.players.size}`);

    // Cancel abandon timeout if a player reconnects
    if (this.abandonTimeout) {
      clearTimeout(this.abandonTimeout);
      this.abandonTimeout = null;
      console.log("Abandon timeout cancelled — player reconnected");
    }

    // --- SECURITY: Verify game token server-side ---
    // The platform issues a signed JWT (game token) containing userId, devMode, soloMode, etc.
    // We verify the token here instead of trusting client-provided options, because a malicious
    // client could set devMode: true in join options to gain access to dev commands.
    // We use ignoreExpiration because the 60s token lifetime may have elapsed by the time the
    // player navigates through the lobby/intro flow, and will definitely be expired on reconnect.
    // The signature check alone is sufficient to prevent forgery.
    let verifiedUserId: string | undefined;
    let verifiedDevMode = false;
    let verifiedSoloMode = false;

    const gameTokenSecret = process.env.GAME_TOKEN_SECRET;
    if (options.gameToken && gameTokenSecret) {
      try {
        const decoded = jwt.verify(options.gameToken, gameTokenSecret, {
          ignoreExpiration: true,
        }) as {
          userId: string;
          gameConfig?: { devMode?: boolean; mode?: string };
        };
        verifiedUserId = decoded.userId;
        verifiedDevMode = decoded.gameConfig?.devMode === true;
        verifiedSoloMode = decoded.gameConfig?.mode === "solo";
        console.log(`[Security] Verified game token for userId: ${verifiedUserId}, devMode: ${verifiedDevMode}`);
      } catch (err) {
        console.error(`[Security] Invalid game token from ${client.sessionId}:`, err);
        throw new Error("Invalid game token");
      }
    } else if (!options.spectator) {
      console.warn(`[Security] No game token provided by ${client.sessionId} (gameTokenSecret configured: ${!!gameTokenSecret})`);
    }

    // Use verified values from the JWT, falling back to options only if no secret is configured
    // (e.g. local dev without GAME_TOKEN_SECRET set)
    const userId = verifiedUserId || options.userId;
    const devMode = gameTokenSecret ? verifiedDevMode : (options.devMode || false);
    const soloMode = gameTokenSecret ? verifiedSoloMode : (options.soloMode || false);

    // Capture the polarwinds_sessions.id UUID from the client. Passed in as
    // options.sessionId by the lobby (useGameLobby gets it from join-matchmaking's
    // response). Used as the S3 prefix for transcripts so they co-locate with
    // team-feedback.json (which Performance.tsx keys off the same UUID).
    // Fallback to roomId on miss — unsigned value, so no identity risk.
    if (!this.polarWindsSessionId && typeof options.sessionId === "string" && options.sessionId.length > 0) {
      this.polarWindsSessionId = options.sessionId;
      console.log(`Captured polarWindsSessionId=${this.polarWindsSessionId} from client join options`);
    } else if (!this.polarWindsSessionId && !options.spectator) {
      console.warn(`GameRoom ${this.roomId}: no sessionId in client join options; transcript paths will fall back to roomId`);
    }

    // --- REJECT UNKNOWN PLAYERS MID-GAME ---
    // If game has started, only allow reconnecting players (userId must be in userIdToColor)
    if (this.state.gameStarted && !options.spectator) {
      const isReconnecting = userId && this.userIdToColor.has(userId);
      if (!isReconnecting) {
        throw new Error("Game already in progress");
      }
    }

    // --- SPECTATOR HANDLING ---
    if (options.spectator) {
      console.log(`Spectator ${client.sessionId} joined room ${this.roomId}`);
      this.spectatorSessionIds.add(client.sessionId);

      // If the game has already started and voice is configured, send a LiveKit token
      if (this.state.gameStarted && this.livekitRoomName && this.livekitService.isConfigured()) {
        try {
          const token = await this.livekitService.generateToken(
            this.livekitRoomName,
            client.sessionId,
            "SPECTATOR"
          );
          client.send("voiceReady", {
            token,
            livekitUrl: process.env.LIVEKIT_URL,
            roomName: this.livekitRoomName,
          });
          console.log(`Sent LiveKit token to spectator ${client.sessionId}`);
        } catch (error) {
          console.error(`Failed to generate spectator LiveKit token:`, error);
        }
      }
      return; // Skip all player setup
    }

    // Player name comes from the client join options. (removed) previously fetched
    // the player's name/school/discord from a player-profile lookup by userId.
    let playerName = typeof options.playerName === "string" ? options.playerName : "";
    let playerSchool = "";
    let playerDiscordName = "";
    if (userId) {
      this.userIds.set(client.sessionId, userId);
      console.log(`Player ${client.sessionId} has userId: ${userId}, name: ${playerName}`);
    }

    // Set solo mode from first player joining (the one who created the room)
    if (this.state.players.size === 0 && soloMode) {
      this.isSoloMode = true;
      console.log("Room set to SOLO mode");
    }
    if (this.state.players.size === 0 && devMode) {
      this.isDevMode = true;
      console.log("Room set to DEV mode");
    }

    // Check if this is a reconnecting player (by userId)
    const existingColor = userId ? this.userIdToColor.get(userId) : null;

    if (existingColor) {
      // Reconnecting player - restore their color
      console.log(`Player ${client.sessionId} reconnecting with userId ${userId}, restoring color ${existingColor}`);

      // Find and update the existing player entry (update sessionId)
      let existingPlayer: Player | null = null;
      let oldSessionId: string | null = null;
      this.state.players.forEach((player, sessionId) => {
        if (player.color === existingColor) {
          existingPlayer = player;
          oldSessionId = sessionId;
        }
      });

      if (existingPlayer && oldSessionId) {
        // Remove old entry and add with new sessionId
        this.state.players.delete(oldSessionId);
        existingPlayer.sessionId = client.sessionId;
        existingPlayer.name = playerName || existingPlayer.name;
        existingPlayer.school = playerSchool || existingPlayer.school;
        existingPlayer.discordName = playerDiscordName || existingPlayer.discordName;
        this.state.players.set(client.sessionId, existingPlayer);
        console.log(`Restored player ${existingColor} at position (${existingPlayer.x}, ${existingPlayer.y})`);
      } else {
        // Player entry was cleaned up, recreate with same color
        this.assignedColors.add(existingColor);
        const player = new Player();
        player.color = existingColor;
        player.sessionId = client.sessionId;
        player.name = playerName;
        player.school = playerSchool;
        player.discordName = playerDiscordName;
        // Use default position for color
        switch (existingColor) {
          case "RED": player.x = 10; player.y = 14; break;
          case "GREEN": player.x = 12; player.y = 14; break;
          case "BLUE": player.x = 14; player.y = 14; break;
        }
        this.state.players.set(client.sessionId, player);
        console.log(`Recreated player ${existingColor} at position (${player.x}, ${player.y})`);
      }

      console.log(`Total players now: ${this.state.players.size}`);

      // Send LiveKit token to reconnecting player if voice chat is active
      if (this.state.gameStarted && this.livekitRoomName && this.livekitService.isConfigured()) {
        try {
          const token = await this.livekitService.generateToken(
            this.livekitRoomName,
            userId,
            playerName || existingColor
          );
          client.send("voiceReady", {
            token,
            livekitUrl: process.env.LIVEKIT_URL,
            roomName: this.livekitRoomName,
            playerColors: Object.fromEntries(this.userIdToColor),
          });
          console.log(`Sent LiveKit token to reconnecting player ${existingColor} (identity: ${userId})`);
        } catch (error) {
          console.error(`Failed to generate LiveKit token for reconnecting player:`, error);
        }
      }

      return;
    }

    // New player - assign a color
    const availableColor = this.playerColors.find(
      (color) => !this.assignedColors.has(color)
    );

    if (!availableColor) {
      console.log("No available color for player, rejecting join");
      client.leave();
      return;
    }

    console.log(`Assigning color ${availableColor} to player ${client.sessionId}`);
    this.assignedColors.add(availableColor);

    // Track userId -> color mapping for reconnection
    if (userId) {
      this.userIdToColor.set(userId, availableColor);
    }

    const player = new Player();
    player.color = availableColor;
    player.sessionId = client.sessionId;
    player.name = playerName;
    player.school = playerSchool;
    player.discordName = playerDiscordName;

    // Set initial position based on color
    switch (availableColor) {
      case "RED":
        player.x = 10;
        player.y = 14;
        break;
      case "GREEN":
        player.x = 12;
        player.y = 14;
        break;
      case "BLUE":
        player.x = 14;
        player.y = 14;
        break;
    }

    console.log(`Player ${availableColor} starting at position (${player.x}, ${player.y})`);

    this.state.players.set(client.sessionId, player);

    // Paint initial cell
    const cellKey = `${player.x},${player.y}`;
    const cell = new GridCell();
    cell.color = player.color;
    this.state.gridColors.set(cellKey, cell);

    console.log(`Total players now: ${this.state.players.size}`);

    // In solo mode, create the remaining 2 players and start immediately
    if (this.isSoloMode && this.state.players.size === 1 && !this.state.gameStarted) {
      const positions: Record<string, { x: number; y: number }> = {
        RED: { x: 10, y: 14 },
        GREEN: { x: 12, y: 14 },
        BLUE: { x: 14, y: 14 },
      };

      for (const color of this.playerColors) {
        if (this.assignedColors.has(color)) continue;

        this.assignedColors.add(color);
        const soloPlayer = new Player();
        soloPlayer.color = color;
        soloPlayer.sessionId = `solo-${color.toLowerCase()}`;
        soloPlayer.name = color;
        soloPlayer.x = positions[color].x;
        soloPlayer.y = positions[color].y;

        this.state.players.set(soloPlayer.sessionId, soloPlayer);

        // Paint initial cell
        const soloCellKey = `${soloPlayer.x},${soloPlayer.y}`;
        const soloCell = new GridCell();
        soloCell.color = soloPlayer.color;
        this.state.gridColors.set(soloCellKey, soloCell);

        console.log(`Solo mode: Created ${color} player at (${soloPlayer.x}, ${soloPlayer.y})`);
      }

      console.log("Solo mode: All 3 players created, initializing game...");
      this.initializeGame();
      return;
    }

    // If all 3 players have joined, initialize the game
    if (this.state.players.size === 3 && !this.state.gameStarted) {
      console.log("All 3 players joined! Initializing game...");
      this.initializeGame();
    }
  }

  onLeave(client: Client, consented: boolean) {
    console.log(client.sessionId, "left!", consented ? "(consented)" : "(disconnected)");
    console.log(`Clients remaining: ${this.clients.length - 1}, autoDispose: ${this.autoDispose}`);

    if (this.spectatorSessionIds.has(client.sessionId)) {
      this.spectatorSessionIds.delete(client.sessionId);
      console.log(`Spectator ${client.sessionId} left`);
      return;
    }

    const player = this.state.players.get(client.sessionId);
    const userId = this.userIds.get(client.sessionId);

    if (player) {
      if (this.isSoloMode && !userId) {
        // Solo mode fake client disconnected - free the slot immediately so new fake clients can join
        this.assignedColors.delete(player.color);
        this.state.players.delete(client.sessionId);
        console.log(`Solo mode fake client ${player.color} disconnected, slot freed`);
      } else if (consented && !this.state.gameStarted) {
        // Player intentionally cancelled before game started - free the slot
        this.assignedColors.delete(player.color);
        this.state.players.delete(client.sessionId);
        if (userId) {
          this.userIdToColor.delete(userId);
        }
        console.log(`Player ${player.color} cancelled before game start, slot freed`);
      } else {
        // Real player disconnected during game - keep slot reserved for reconnection via joinById
        // Don't remove player data or color assignment
        console.log(`Player ${player.color} disconnected, keeping slot reserved for reconnection`);
        console.log(`Players in state: ${this.state.players.size}, assigned colors: ${Array.from(this.assignedColors).join(', ')}`);
      }
    }

    // Clean up sessionId -> userId mapping (but keep userIdToColor for reconnection)
    this.userIds.delete(client.sessionId);

    // If room is empty and game hasn't started, dispose the room
    // Note: this.clients is already updated (client removed) before onLeave is called
    if (this.clients.length === 0 && !this.state.gameStarted) {
      console.log("Last player left before game started, disposing room");
      this.disconnect();
    }

    // If game is active and no real clients remain, start abandon countdown
    // (spectators don't count — filter them out)
    const realClients = this.clients.filter(c => !this.spectatorSessionIds.has(c.sessionId));
    if (this.state.gameStarted && !this.state.isGameOver && realClients.length === 0) {
      console.log(`All players disconnected during active game, starting ${this.ABANDON_TIMEOUT / 1000}s abandon timeout`);
      this.abandonTimeout = setTimeout(async () => {
        console.log("Abandon timeout expired — no players reconnected, marking abandoned and disposing room");
        this.state.isGameOver = true;
        await this.endPolarWindsSession({ abandoned: true });
        this.disconnect();
      }, this.ABANDON_TIMEOUT);
    }
  }

  async onDispose() {
    console.log("room", this.roomId, "disposing...");
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }
    if (this.enemyTimer) {
      clearInterval(this.enemyTimer);
      this.enemyTimer = null;
    }
    if (this.lobbyTimeout) {
      clearTimeout(this.lobbyTimeout);
      this.lobbyTimeout = null;
    }
    if (this.abandonTimeout) {
      clearTimeout(this.abandonTimeout);
      this.abandonTimeout = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    // Safety net: if the session was never successfully ended in the DB
    // (e.g. server shutdown, or endPolarWindsSession failed with a 500), retry now
    if ((this.polarWindsSessionId || this.roomId) && !this.sessionEndedInDb) {
      console.log("Room disposing with session not ended in DB — retrying as abandoned with replay data");
      await this.endPolarWindsSession({ abandoned: true });
    }
  }

  private async initializeGame() {
    // Cancel lobby timeout since game is starting
    if (this.lobbyTimeout) {
      clearTimeout(this.lobbyTimeout);
      this.lobbyTimeout = null;
    }

    // Hide from matchmaking but still allow joinById for reconnection
    await this.setPrivate(true);

    this.state.gameStarted = true;

    console.log(`Game mode: ${this.isSoloMode ? 'SOLO' : 'MULTIPLAYER'}`);

    // Generate initial collectibles
    this.generateInitialCollectibles();
    this.calculateScores();

    // Spawn initial enemies from config (if any enemy rules exist)
    // Skip enemy spawn rules when a level spec is loaded (enemies come from the level spec instead)
    if (!this.levelSpec) {
      this.spawnEnemiesForStage(1);
      if (this.collectibleSpawnConfig.enemy_spawn_rules?.length) {
        this.startEnemyTimer();
      }
    }

    // Initialize LiveKit voice chat (only in multiplayer mode)
    if (!this.isSoloMode) {
      await this.initializeVoiceChat();
    }

    // Start countdown immediately — no ready-up handshake needed
    this.startGameplay();
  }

  private startGameplay() {
    console.log("Starting countdown...");

    // Start 10-second countdown
    this.state.countdown = 10;
    this.countdownTimer = setInterval(() => {
      // Explicit assignment so @colyseus/schema always encodes a patch (postfix -- can miss updates in some builds).
      const next = this.state.countdown - 1;
      this.state.countdown = next;
      if (next <= 0) {
        if (this.countdownTimer) {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
        }
        this.state.timeRemaining = this.GAME_DURATION;
        this.gameStartTime = Date.now();
        this.startGameTimer();
        console.log("Countdown complete — game timer started!");
      }
    }, 1000);
  }

  private async initializeVoiceChat() {
    console.log("initializeVoiceChat called, isConfigured:", this.livekitService.isConfigured());

    if (!this.livekitService.isConfigured()) {
      console.log("LiveKit not configured, skipping voice chat initialization");
      return;
    }

    // Generate LiveKit room name tied to Colyseus room
    this.livekitRoomName = `polar-winds-${this.roomId}`;
    const livekitUrl = process.env.LIVEKIT_URL;
    console.log("LiveKit URL from env:", livekitUrl);

    // Build userId→color map for the voice overlay on clients
    const playerColors = Object.fromEntries(this.userIdToColor);

    // Generate tokens for all players and send to each
    // Use userId as identity so voice works consistently across lobby and game
    const tokenPromises = Array.from(this.state.players.entries()).map(
      async ([sessionId, player]) => {
        try {
          const identity = this.userIds.get(sessionId) || sessionId;
          const token = await this.livekitService.generateToken(
            this.livekitRoomName!,
            identity,
            player.name || player.color
          );

          const client = this.clients.find((c) => c.sessionId === sessionId);
          if (client) {
            client.send("voiceReady", {
              token,
              livekitUrl,
              roomName: this.livekitRoomName,
              playerColors,
            });
            console.log(`Sent LiveKit token to player ${player.color} (identity: ${identity})`);
          }
        } catch (error) {
          console.error(`Failed to generate LiveKit token for ${player.color}:`, error);
        }
      }
    );

    await Promise.all(tokenPromises);

    // Send LiveKit tokens to any connected spectators
    for (const spectatorSessionId of this.spectatorSessionIds) {
      try {
        const token = await this.livekitService.generateToken(
          this.livekitRoomName!,
          spectatorSessionId,
          "SPECTATOR"
        );
        const client = this.clients.find((c) => c.sessionId === spectatorSessionId);
        if (client) {
          client.send("voiceReady", {
            token,
            livekitUrl,
            roomName: this.livekitRoomName,
            playerColors,
          });
          console.log(`Sent LiveKit token to spectator ${spectatorSessionId}`);
        }
      } catch (error) {
        console.error(`Failed to generate spectator LiveKit token:`, error);
      }
    }
  }

  private startGameTimer() {
    this.gameTimer = setInterval(() => {
      if (this.isDevMode) {
        this.state.timeRemaining--;
      } else if (this.state.timeRemaining > 0) {
        this.state.timeRemaining--;
      }

      // Log score snapshot every 30 seconds for replay
      const elapsed = this.GAME_DURATION - this.state.timeRemaining;
      if (elapsed > 0 && elapsed % 30 === 0) {
        const scoreSnapshot: Record<string, unknown> = { e: "score", total: this.state.totalScore };
        this.state.players.forEach((p, sessionId) => {
          scoreSnapshot[this.userIds.get(sessionId) || sessionId] = this.state.scores.get(p.color) || 0;
        });
        this.logEvent(scoreSnapshot);
      }

      if (this.state.timeRemaining <= 0 && !this.state.isGameOver && !this.isDevMode) {
        this.endGame();
      }
    }, 1000);
  }

  private async endGame() {
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    if (this.enemyTimer) {
      clearInterval(this.enemyTimer);
      this.enemyTimer = null;
    }

    // Wait for any in-flight milestone fetches (max 3s). Each fetch broadcasts its
    // own 'milestoneUnlocked' message the moment it resolves, so by the time this
    // await completes all per-milestone broadcasts have already been sent.
    await Promise.race([
      Promise.allSettled(this.pendingMilestoneRequests),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);

    this.state.isGameOver = true;

    console.log("Game ended! Final score:", this.state.highScore);

    await this.endPolarWindsSession();

    // Dispose the room after game ends
    this.disconnect();
  }

  private logEvent(event: Record<string, unknown>) {
    event.t = Date.now() - this.gameStartTime;
    this.replayEvents.push(event);
  }

  private async endPolarWindsSession(_options?: { abandoned?: boolean }) {
    // (removed) Standalone build has no persistence. This previously POSTed the
    // final score and full replay (events + player metadata) to a platform
    // end-session endpoint so the game could be stored/replayed. Replay events are
    // still collected in-memory via logEvent() but are discarded when the room
    // disposes.
  }

  private async updateHighScore(_score: number) {
    // (removed) Standalone build has no persistence. This previously persisted the
    // session's high score to a platform endpoint. The high score still lives in
    // room state (this.state.highScore) for the duration of the session.
  }

  private generateInitialCollectibles() {
    // Use level spec if available, otherwise use random spawn rules
    if (this.levelSpec && this.levelSpec.stages.length > 0) {
      this.spawnCluesFromLevelSpec(1);
      console.log(`Generated ${this.state.collectibles.length} initial collectibles from level spec`);
      return;
    }

    const colors: PlayerColor[] = ["RED", "GREEN", "BLUE"];
    const collectibleCounters = new Map<CollectibleType, number>();

    // Calculate center offset for the 26x26 grid
    const center = Math.floor(this.MAX_GRID_SIZE / 2);
    const halfWidth = Math.floor(this.INITIAL_VISIBLE_WIDTH / 2);
    const halfHeight = Math.floor(this.INITIAL_VISIBLE_HEIGHT / 2);
    const minX = center - halfWidth;
    const maxX = center + halfWidth - 1;
    const minY = center - halfHeight;
    const maxY = center + halfHeight - 1;

    // Spawn collectibles based on config for stage 1
    for (const rule of this.collectibleSpawnConfig.collectible_spawn_rules) {
      if (rule.first_stage !== 1) continue;

      const counter = collectibleCounters.get(rule.clue_type) || 0;
      collectibleCounters.set(rule.clue_type, counter);

      const props = COLLECTIBLE_PROPERTIES[rule.clue_type];
      const spawnsOnNodes = props.spawnsOnNodes;

      if (props.isNeutral) {
        // Neutral collectibles: spawn num_initial total (not per color)
        for (let i = 0; i < rule.num_initial; i++) {
          const collectible = new Collectible();
          const currentCount = collectibleCounters.get(rule.clue_type)!;
          collectible.id = `NEUTRAL-${rule.clue_type}-${currentCount}`;
          collectibleCounters.set(rule.clue_type, currentCount + 1);
          collectible.color = "NEUTRAL";
          collectible.type = rule.clue_type;

          const handler = CollectibleFactory.getHandler(rule.clue_type);
          let x: number, y: number;
          do {
            if (!spawnsOnNodes) {
              // Spawn at half-integer positions (between nodes)
              x = minX + Math.floor(this.rng.next() * (this.INITIAL_VISIBLE_WIDTH - 1)) + 0.5;
              y = minY + Math.floor(this.rng.next() * (this.INITIAL_VISIBLE_HEIGHT - 1)) + 0.5;
            } else {
              x = minX + Math.floor(this.rng.next() * this.INITIAL_VISIBLE_WIDTH);
              y = minY + Math.floor(this.rng.next() * this.INITIAL_VISIBLE_HEIGHT);
            }
          } while (this.isPositionOccupied(x, y) || !handler.validateSpawnPosition({
            x,
            y,
            minBound: Math.min(minX, minY),
            maxBound: Math.max(maxX, maxY),
            color: "RED", // Color doesn't matter for neutral validation
            existingCollectibles: Array.from(this.state.collectibles),
            gridMinX: minX,
            gridMaxX: maxX,
            gridMinY: minY,
            gridMaxY: maxY,
          }));

          collectible.x = x;
          collectible.y = y;

          // Assign random orientation for collectibles that spawn between nodes
          if (!spawnsOnNodes) {
            const orientations: CollectibleOrientation[] = [0, 90, 180, 270];
            collectible.orientation = orientations[Math.floor(this.rng.next() * 4)];
            collectible.isFlipped = this.rng.next() < 0.5;
          }

          this.state.collectibles.push(collectible);
        }
      } else {
        // Color-based collectibles: spawn num_initial per color
        for (const color of colors) {
          for (let i = 0; i < rule.num_initial; i++) {
            const collectible = new Collectible();
            const currentCount = collectibleCounters.get(rule.clue_type)!;
            collectible.id = `${color}-${rule.clue_type}-${currentCount}`;
            collectibleCounters.set(rule.clue_type, currentCount + 1);
            collectible.num = currentCount;
            console.log("Collectible: " + collectible.id + " is number " + collectible.num);
            collectible.color = color;
            collectible.type = rule.clue_type;

            const handler = CollectibleFactory.getHandler(rule.clue_type);
            let x: number, y: number;
            do {
              if (!spawnsOnNodes) {
                // Spawn at half-integer positions (between nodes)
                x = minX + Math.floor(this.rng.next() * (this.INITIAL_VISIBLE_WIDTH - 1)) + 0.5;
                y = minY + Math.floor(this.rng.next() * (this.INITIAL_VISIBLE_HEIGHT - 1)) + 0.5;
              } else {
                x = minX + Math.floor(this.rng.next() * this.INITIAL_VISIBLE_WIDTH);
                y = minY + Math.floor(this.rng.next() * this.INITIAL_VISIBLE_HEIGHT);
              }
            } while (this.isPositionOccupied(x, y) || !handler.validateSpawnPosition({
              x,
              y,
              minBound: Math.min(minX, minY),
              maxBound: Math.max(maxX, maxY),
              color,
              existingCollectibles: Array.from(this.state.collectibles),
              gridMinX: minX,
              gridMaxX: maxX,
              gridMinY: minY,
              gridMaxY: maxY,
            }));

            collectible.x = x;
            collectible.y = y;

            // Assign random orientation for collectibles that spawn between nodes
            if (!spawnsOnNodes) {
              const orientations: CollectibleOrientation[] = [0, 90, 180, 270];
              collectible.orientation = orientations[Math.floor(this.rng.next() * 4)];
            }

            this.state.collectibles.push(collectible);
          }
        }
      }
    }

    console.log(`Generated ${this.state.collectibles.length} initial collectibles`);
  }

  private spawnCluesFromLevelSpec(stage: number) {
    if (!this.levelSpec) return;

    // Stage is 1-indexed, array is 0-indexed
    const stageIndex = stage - 1;
    if (stageIndex < 0 || stageIndex >= this.levelSpec.stages.length) {
      console.log(`No level spec data for stage ${stage}`);
      return;
    }

    const stageData = this.levelSpec.stages[stageIndex];
    const center = Math.floor(this.MAX_GRID_SIZE / 2);

    // Spawn clues
    for (const clue of stageData.clues) {
      const collectible = new Collectible();
      collectible.id = `${clue.color}-${clue.type}-${this.state.collectibles.length}`;
      collectible.type = clue.type;
      collectible.num = clue.num;
      collectible.color = clue.color;
      // Convert level spec coordinates (centered at 0,0) to grid coordinates
      // Unreal uses center at floor((size-1)/2), we use floor(size/2), so offset by 1
      collectible.x = center + clue.x - 1;
      collectible.y = center + clue.y - 1;
      collectible.orientation = clue.orientation || 0;
      collectible.isFlipped = clue.isFlipped || false;

      // Store polyomino shape if present
      if (clue.shape) {
        collectible.shapeData = JSON.stringify(clue.shape);
      }

      this.state.collectibles.push(collectible);
    }

    // Spawn enemies
    if (stageData.enemies) {
      for (const enemyDef of stageData.enemies) {
        const enemy = new Enemy();
        enemy.id = `enemy-${Date.now()}-${this.state.enemies.length}`;
        enemy.x = center + enemyDef.x - 1;
        enemy.y = center + enemyDef.y - 1;
        enemy.personality = enemyDef.personality || "same-color-avoiding";
        this.state.enemies.push(enemy);
        console.log(`Spawned enemy from level spec at (${enemy.x}, ${enemy.y})`);
      }
    }

    console.log(`Spawned ${stageData.clues.length} clues for stage ${stage} from level spec`);
  }

  private isPositionOccupied(x: number, y: number): boolean {
    // Check if any player is at this position
    for (const [, player] of this.state.players) {
      if (player.x === x && player.y === y) return true;
    }

    // Check if any collectible is at this position
    for (const collectible of this.state.collectibles) {
      if (collectible.x === x && collectible.y === y) return true;
    }

    return false;
  }

  private calculateScores() {
    const scores: Record<PlayerColor, number> = {
      RED: 0,
      GREEN: 0,
      BLUE: 0,
    };

    const colors: PlayerColor[] = ["RED", "GREEN", "BLUE"];


    /* Only clear activation when needed — writing every collectible every move
       explodes Colyseus patch size and freezes clients on large clue counts. */
    for (const collectible of this.state.collectibles) {
      if (collectible.isActivated) {
        collectible.isActivated = false;
      }
    }

    const allCollectiblesList = Array.from(this.state.collectibles);

    for (const color of colors) {
      const components = this.findConnectedComponents(color);

      // Get all collectibles for this color
      const colorCollectibles = allCollectiblesList.filter(
        (c) => c.color === color
      );

      // Process each collectible using its handler
      for (const collectible of colorCollectibles) {
        const handler = CollectibleFactory.getHandler(collectible.type);
        const score = handler.process({
          collectible,
          gridColors: this.state.gridColors,
          allCollectibles: allCollectiblesList,
          color,
          components,
        });
        if (collectible.score !== score) {
          collectible.score = score;
        }
        scores[color] += score;
      }
    }

    // Process neutral collectibles - score is split equally among all players
    const neutralCollectibles = allCollectiblesList.filter(
      (c) => c.color === "NEUTRAL"
    );

    for (const collectible of neutralCollectibles) {
      const handler = CollectibleFactory.getHandler(collectible.type);
      const score = handler.process({
        collectible,
        gridColors: this.state.gridColors,
        allCollectibles: allCollectiblesList,
        color: "RED", // Color doesn't matter for neutral collectibles
        components: [],
      });
      if (collectible.score !== score) {
        collectible.score = score;
      }
      // Split score equally among all players
      const scorePerPlayer = score / 3;
      scores.RED += scorePerPlayer;
      scores.GREEN += scorePerPlayer;
      scores.BLUE += scorePerPlayer;
    }

    // Update state (skip unchanged map entries to shrink encoded patches)
    const nextTotal = scores.RED + scores.GREEN + scores.BLUE;
    if (this.state.scores.get("RED") !== scores.RED) {
      this.state.scores.set("RED", scores.RED);
    }
    if (this.state.scores.get("GREEN") !== scores.GREEN) {
      this.state.scores.set("GREEN", scores.GREEN);
    }
    if (this.state.scores.get("BLUE") !== scores.BLUE) {
      this.state.scores.set("BLUE", scores.BLUE);
    }

    if (this.state.totalScore !== nextTotal) {
      this.state.totalScore = nextTotal;
    }

    // Update high score if total score increased
    if (this.state.totalScore > this.state.highScore) {
      this.state.highScore = this.state.totalScore;
      this.updateHighScore(this.state.highScore);
    }

    // Check for stage advancement
    this.checkStageAdvancement();

    // Report newly activated collectible types as milestones
    this.reportNewMilestones();
  }

  private reportNewMilestones() {
    if (this.isSoloMode) return;

    const newTypes: string[] = [];
    for (const collectible of this.state.collectibles) {
      if (collectible.isActivated && collectible.score > 0 && !this.milestoneReportedTypes.has(collectible.type)) {
        this.milestoneReportedTypes.add(collectible.type);
        newTypes.push(collectible.type);
      }
    }

    if (newTypes.length === 0) return;

    const playerIds = Array.from(this.userIds.values());
    if (playerIds.length === 0) return;

    // (removed) Each newly activated type used to be POSTed to a platform
    // milestone endpoint, which decided per-user whether the milestone was "new"
    // and returned its display name/description. Standalone has no DB, so we
    // broadcast locally instead: milestoneReportedTypes already dedupes
    // each type to once per game. name/description are null — the client falls back
    // to the built-in milestone asset name (see Index.tsx milestone showcase).
    for (const type of newTypes) {
      for (const [userId, color] of this.userIdToColor.entries()) {
        if (!playerIds.includes(userId)) continue;
        this.broadcast("milestoneUnlocked", {
          color,
          type,
          name: null,
          description: null,
        });
      }
    }
  }

  private findConnectedComponents(
    color: PlayerColor
  ): Array<Array<{ x: number; y: number }>> {
    const visited = new Set<string>();
    const components: Array<Array<{ x: number; y: number }>> = [];

    for (const [key, cell] of this.state.gridColors) {
      if (cell.color !== color || visited.has(key)) continue;

      const [x, y] = key.split(",").map(Number);
      const component = this.bfs(x, y, color, visited);

      if (component.length > 0) {
        components.push(component);
      }
    }

    return components;
  }

  private bfs(
    startX: number,
    startY: number,
    color: PlayerColor,
    visited: Set<string>
  ): Array<{ x: number; y: number }> {
    const queue: Array<{ x: number; y: number }> = [
      { x: startX, y: startY },
    ];
    const component: Array<{ x: number; y: number }> = [];
    const startKey = `${startX},${startY}`;

    visited.add(startKey);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = [
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
        { x: current.x, y: current.y - 1 },
        { x: current.x, y: current.y + 1 },
      ];

      for (const neighbor of neighbors) {
        const key = `${neighbor.x},${neighbor.y}`;

        if (visited.has(key)) continue;

        const cell = this.state.gridColors.get(key);
        if (cell && cell.color === color) {
          visited.add(key);
          queue.push(neighbor);
        }
      }
    }

    return component;
  }

  private checkStageAdvancement() {
    // In dev mode, stage ups are manual only
    if (this.isDevMode) return;

    // Determine what stage we should be at based on total score
    let targetStage = 1;
    for (let i = 0; i < this.stageThresholds.length; i++) {
      if (this.state.totalScore >= this.stageThresholds[i]) {
        targetStage = i + 2; // Stage 2 at threshold[0], Stage 3 at threshold[1], etc.
      }
    }

    // If we need to advance stages
    if (targetStage > this.state.stage) {
      console.log(`Advancing from stage ${this.state.stage} to stage ${targetStage}`);
      this.advanceToStage(targetStage);
    }
  }

  private advanceToStage(newStage: number) {
    // Log stage advance for replay
    this.logEvent({ e: "stage", stage: newStage });

    const oldGridWidth = this.state.gridWidth;
    const oldGridHeight = this.state.gridHeight;
    const previousStage = this.state.stage;
    this.state.stage = newStage;

    // Simply expand the visible area by 2 per stage
    // Stage 1: 10x8, Stage 2: 12x10, ..., max is 26x26
    this.state.gridWidth = Math.min(
      this.INITIAL_VISIBLE_WIDTH + (newStage - 1) * 2,
      this.MAX_GRID_SIZE
    );
    this.state.gridHeight = Math.min(
      this.INITIAL_VISIBLE_HEIGHT + (newStage - 1) * 2,
      this.MAX_GRID_SIZE
    );

    // Use level spec if available
    if (this.levelSpec) {
      const stagesAdvanced = newStage - previousStage;
      for (let s = 0; s < stagesAdvanced; s++) {
        const currentStage = previousStage + s + 1;
        this.spawnCluesFromLevelSpec(currentStage);
      }
      console.log(`Stage ${newStage}: Visible area expanded from ${oldGridWidth}x${oldGridHeight} to ${this.state.gridWidth}x${this.state.gridHeight} (using level spec)`);
      return;
    }

    // Add new collectibles for each stage advancement
    const colors: PlayerColor[] = ["RED", "GREEN", "BLUE"];
    const center = Math.floor(this.MAX_GRID_SIZE / 2);
    const halfWidth = Math.floor(this.state.gridWidth / 2);
    const halfHeight = Math.floor(this.state.gridHeight / 2);
    const minX = center - halfWidth;
    const maxX = center + halfWidth - 1;
    const minY = center - halfHeight;
    const maxY = center + halfHeight - 1;

    const stagesAdvanced = newStage - previousStage;
    let totalCollectiblesAdded = 0;

    for (let s = 0; s < stagesAdvanced; s++) {
      const currentStage = previousStage + s + 1;

      // Spawn collectibles based on config
      for (const rule of this.collectibleSpawnConfig.collectible_spawn_rules) {
        // Check if this collectible type should spawn at this stage
        if (currentStage < rule.first_stage) continue;

        // For the first_stage, use num_initial, otherwise use num_subsequent
        const numToSpawn = currentStage === rule.first_stage ? rule.num_initial : rule.num_subsequent;

        const props = COLLECTIBLE_PROPERTIES[rule.clue_type];
        const spawnsOnNodes = props.spawnsOnNodes;

        if (props.isNeutral) {
          // Neutral collectibles: spawn numToSpawn total (not per color)
          for (let i = 0; i < numToSpawn; i++) {
            const collectible = new Collectible();
            collectible.id = `NEUTRAL-${rule.clue_type}-${this.state.collectibles.length}`;
            collectible.color = "NEUTRAL";
            collectible.type = rule.clue_type;

            const handler = CollectibleFactory.getHandler(rule.clue_type);
            let x: number, y: number;
            let attempts = 0;
            const maxAttempts = 100;

            do {
              attempts++;
              if (!spawnsOnNodes) {
                // Spawn at half-integer positions (between nodes)
                x = minX + Math.floor(this.rng.next() * (this.state.gridWidth - 1)) + 0.5;
                y = minY + Math.floor(this.rng.next() * (this.state.gridHeight - 1)) + 0.5;
              } else {
                x = minX + Math.floor(this.rng.next() * this.state.gridWidth);
                y = minY + Math.floor(this.rng.next() * this.state.gridHeight);
              }
            } while ((this.isPositionOccupied(x, y) || !handler.validateSpawnPosition({
              x,
              y,
              minBound: Math.min(minX, minY),
              maxBound: Math.max(maxX, maxY),
              color: "RED",
              existingCollectibles: Array.from(this.state.collectibles),
              gridMinX: minX,
              gridMaxX: maxX,
              gridMinY: minY,
              gridMaxY: maxY,
            })) && attempts < maxAttempts);

            collectible.x = x;
            collectible.y = y;

            // Assign random orientation for collectibles that spawn between nodes
            if (!spawnsOnNodes) {
              const orientations: CollectibleOrientation[] = [0, 90, 180, 270];
              collectible.orientation = orientations[Math.floor(this.rng.next() * 4)];
              collectible.isFlipped = this.rng.next() < 0.5;
            }

            this.state.collectibles.push(collectible);
            totalCollectiblesAdded++;
          }
        } else {
          // Color-based collectibles: spawn numToSpawn per color
          for (const color of colors) {
            for (let i = 0; i < numToSpawn; i++) {
              const collectible = new Collectible();
              collectible.id = `${color}-${rule.clue_type}-${this.state.collectibles.length}`;
              collectible.color = color;
              collectible.type = rule.clue_type;

              const handler = CollectibleFactory.getHandler(rule.clue_type);
              let x: number, y: number;
              let attempts = 0;
              const maxAttempts = 100;

              do {
                attempts++;
                if (!spawnsOnNodes) {
                  // Spawn at half-integer positions (between nodes)
                  x = minX + Math.floor(this.rng.next() * (this.state.gridWidth - 1)) + 0.5;
                  y = minY + Math.floor(this.rng.next() * (this.state.gridHeight - 1)) + 0.5;
                } else {
                  x = minX + Math.floor(this.rng.next() * this.state.gridWidth);
                  y = minY + Math.floor(this.rng.next() * this.state.gridHeight);
                }
              } while ((this.isPositionOccupied(x, y) || !handler.validateSpawnPosition({
                x,
                y,
                minBound: Math.min(minX, minY),
                maxBound: Math.max(maxX, maxY),
                color,
                existingCollectibles: Array.from(this.state.collectibles),
                gridMinX: minX,
                gridMaxX: maxX,
                gridMinY: minY,
                gridMaxY: maxY,
              })) && attempts < maxAttempts);

              collectible.x = x;
              collectible.y = y;

              // Assign random orientation for collectibles that spawn between nodes
              if (!spawnsOnNodes) {
                const orientations: CollectibleOrientation[] = [0, 90, 180, 270];
                collectible.orientation = orientations[Math.floor(this.rng.next() * 4)];
              }

              this.state.collectibles.push(collectible);
              totalCollectiblesAdded++;
            }
          }
        }
      }
    }

    // Spawn enemies for each stage advanced
    for (let s = 0; s < stagesAdvanced; s++) {
      const currentStage = previousStage + s + 1;
      this.spawnEnemiesForStage(currentStage);
    }

    console.log(`Stage ${newStage}: Visible area expanded from ${oldGridWidth}x${oldGridHeight} to ${this.state.gridWidth}x${this.state.gridHeight}, added ${totalCollectiblesAdded} new collectibles`);
  }

  private startClearBoardVoteTimer() {
    // Clear any existing timer
    if (this.clearBoardVoteTimer) {
      clearTimeout(this.clearBoardVoteTimer);
    }

    this.clearBoardVoteTimer = setTimeout(() => {
      // Time expired without all 3 votes - reset
      this.clearBoardVotes.clear();
      this.clearBoardVoteTimer = null;

      // Notify all players that voting expired
      this.broadcast("clearBoardVoteExpired", {});
      console.log("Clear board vote expired - not enough votes");
    }, this.CLEAR_BOARD_VOTE_WINDOW);
  }

  private executeClearBoard() {
    // Clear the timer
    if (this.clearBoardVoteTimer) {
      clearTimeout(this.clearBoardVoteTimer);
      this.clearBoardVoteTimer = null;
    }

    // Clear all grid colors (set to neutral by removing them)
    this.state.gridColors.clear();

    // Reset votes
    this.clearBoardVotes.clear();

    // Recalculate scores
    this.calculateScores();

    // Notify all players that board was cleared
    this.broadcast("boardCleared", {});
    console.log("Board cleared by unanimous vote!");

    // Log clear board for replay
    this.logEvent({ e: "clear_board" });
  }

  private startAbandonGameVoteTimer() {
    if (this.abandonGameVoteTimer) {
      clearTimeout(this.abandonGameVoteTimer);
    }

    this.abandonGameVoteTimer = setTimeout(() => {
      this.abandonGameVotes.clear();
      this.abandonGameVoteTimer = null;

      this.broadcast("abandonGameVoteExpired", {});
      console.log("Abandon game vote expired - not enough votes");
    }, this.ABANDON_GAME_VOTE_WINDOW);
  }

  private async executeAbandonGame() {
    // Clear the timer
    if (this.abandonGameVoteTimer) {
      clearTimeout(this.abandonGameVoteTimer);
      this.abandonGameVoteTimer = null;
    }

    // Reset votes
    this.abandonGameVotes.clear();

    console.log("Game abandoned by unanimous vote!");

    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    if (this.enemyTimer) {
      clearInterval(this.enemyTimer);
      this.enemyTimer = null;
    }

    // Wait for any in-flight milestone fetches (max 3s). Each fetch broadcasts its
    // own 'milestoneUnlocked' message the moment it resolves, so by the time this
    // await completes all per-milestone broadcasts have already been sent to clients.
    await Promise.race([
      Promise.allSettled(this.pendingMilestoneRequests),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);

    // Notify all players — clients will call room.leave() on receiving this
    this.broadcast("gameAbandoned", {});

    // End the game as abandoned
    this.state.isGameOver = true;

    await this.endPolarWindsSession({ abandoned: true });
    this.disconnect();
  }

  private spawnEnemiesForStage(stage: number) {
    const rules = this.collectibleSpawnConfig.enemy_spawn_rules;
    if (!rules || rules.length === 0) return;

    for (const rule of rules) {
      if (stage < rule.first_stage) continue;
      const count = stage === rule.first_stage ? rule.num_initial : rule.num_subsequent;
      this.spawnEnemies(count, rule.personality);
    }
  }

  private spawnEnemies(count: number, personality?: EnemyPersonality) {
    const personalities: EnemyPersonality[] = [
      "red-avoiding", "green-avoiding", "blue-avoiding", "same-color-avoiding", "prismatic"
    ];

    const center = Math.floor(this.MAX_GRID_SIZE / 2);
    const halfWidth = Math.floor(this.state.gridWidth / 2);
    const halfHeight = Math.floor(this.state.gridHeight / 2);
    const minX = center - halfWidth;
    const minY = center - halfHeight;

    for (let i = 0; i < count; i++) {
      const enemy = new Enemy();
      enemy.id = `enemy-${Date.now()}-${i}-${this.state.enemies.length}`;
      enemy.personality = personality || personalities[Math.floor(this.enemyRng.next() * personalities.length)];

      // Spawn on a random cell within bounds
      let attempts = 0;
      do {
        enemy.x = minX + Math.floor(this.enemyRng.next() * this.state.gridWidth);
        enemy.y = minY + Math.floor(this.enemyRng.next() * this.state.gridHeight);
        attempts++;
      } while (this.isEnemySpawnBlocked(enemy.x, enemy.y) && attempts < 100);

      this.state.enemies.push(enemy);
      console.log(`Spawned enemy ${enemy.id} at (${enemy.x}, ${enemy.y}) with personality: ${enemy.personality}`);
    }
  }

  private isEnemySpawnBlocked(x: number, y: number): boolean {
    // Don't spawn on top of players
    for (const [, player] of this.state.players) {
      if (player.x === x && player.y === y) return true;
    }
    // Don't spawn on top of other enemies
    for (const enemy of this.state.enemies) {
      if (enemy.x === x && enemy.y === y) return true;
    }
    return false;
  }

  private startEnemyTimer() {
    this.enemyTimer = setInterval(() => {
      this.moveEnemies();
    }, this.ENEMY_MOVE_DELAY);
  }

  private moveEnemies() {
    if (this.state.countdown > 0) return;

    const center = Math.floor(this.MAX_GRID_SIZE / 2);
    const halfWidth = Math.floor(this.state.gridWidth / 2);
    const halfHeight = Math.floor(this.state.gridHeight / 2);
    const minX = center - halfWidth;
    const maxX = center + halfWidth - 1;
    const minY = center - halfHeight;
    const maxY = center + halfHeight - 1;

    // Phase 1: Compute all moves based on the current board state
    const moves: Array<{ enemy: Enemy; oldX: number; oldY: number; newX: number; newY: number }> = [];

    for (const enemy of this.state.enemies) {
      // Get adjacent cells (up, down, left, right)
      const adjacent = [
        { x: enemy.x, y: enemy.y - 1 },
        { x: enemy.x, y: enemy.y + 1 },
        { x: enemy.x - 1, y: enemy.y },
        { x: enemy.x + 1, y: enemy.y },
      ].filter(pos =>
        pos.x >= minX && pos.x <= maxX &&
        pos.y >= minY && pos.y <= maxY
      );

      if (adjacent.length === 0) continue;

      // Choose cell based on personality (reads current board state)
      const chosen = this.chooseEnemyMove(enemy, adjacent);
      if (chosen) {
        moves.push({ enemy, oldX: enemy.x, oldY: enemy.y, newX: chosen.x, newY: chosen.y });
      }
    }

    // Phase 2: Apply all moves at once
    for (const move of moves) {
      move.enemy.x = move.newX;
      move.enemy.y = move.newY;

      // Erase the cell the enemy just LEFT (set to blank)
      const oldCellKey = `${move.oldX},${move.oldY}`;
      this.state.gridColors.delete(oldCellKey);

      // Log enemy move for replay
      this.logEvent({ e: "enemy_move", id: move.enemy.id, x: move.newX, y: move.newY });
    }

    // Recalculate scores since cells were erased
    this.calculateScores();
  }

  private chooseEnemyMove(
    enemy: Enemy,
    adjacent: Array<{ x: number; y: number }>
  ): { x: number; y: number } | null {
    const currentCellKey = `${enemy.x},${enemy.y}`;
    const currentCell = this.state.gridColors.get(currentCellKey);
    const currentColor = currentCell?.color; // undefined means blank

    // Map PlayerColor to the color name the personality cares about
    // "RED" player color displays as orange, "GREEN" as green, "BLUE" as blue
    const avoidedPlayerColor: PlayerColor | null =
      enemy.personality === "red-avoiding" ? "RED" :
      enemy.personality === "green-avoiding" ? "GREEN" :
      enemy.personality === "blue-avoiding" ? "BLUE" :
      null; // same-color-avoiding handled separately

    // Categorize adjacent cells
    const preferred: Array<{ x: number; y: number }> = [];
    const acceptable: Array<{ x: number; y: number }> = [];

    for (const pos of adjacent) {
      const cellKey = `${pos.x},${pos.y}`;
      const cell = this.state.gridColors.get(cellKey);
      const cellColor = cell?.color; // undefined = blank

      if (enemy.personality === "prismatic") {
        // Never step orange→green, green→blue, or blue→orange
        // (RED→GREEN, GREEN→BLUE, BLUE→RED)
        const forbidden =
          (currentColor === "RED" && cellColor === "GREEN") ||
          (currentColor === "GREEN" && cellColor === "BLUE") ||
          (currentColor === "BLUE" && cellColor === "RED");

        if (!forbidden) {
          preferred.push(pos);
        }
        // forbidden transitions are simply not added to any pool
      } else if (enemy.personality === "same-color-avoiding") {
        // Never step from one color onto the same color, but can always step to/from blanks
        if (!currentColor || !cellColor || currentColor !== cellColor) {
          preferred.push(pos);
        } else {
          acceptable.push(pos);
        }
      } else {
        // Color-avoiding personalities
        const isAvoidedColor = cellColor === avoidedPlayerColor;
        const isCurrentlyOnAvoided = currentColor === avoidedPlayerColor;

        if (!isAvoidedColor) {
          // Not the avoided color — always preferred
          preferred.push(pos);
        } else if (isCurrentlyOnAvoided) {
          // On avoided color, stepping onto avoided color — acceptable but not preferred
          acceptable.push(pos);
        }
        // else: not on avoided color, target is avoided color — never step there (skip)
      }
    }

    // Pick from preferred first, then acceptable, then stay put
    const pool = preferred.length > 0 ? preferred : acceptable;
    if (pool.length === 0) return null;

    return pool[Math.floor(this.enemyRng.next() * pool.length)];
  }
}
