import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export type PlayerColor = "RED" | "GREEN" | "BLUE";

export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") color: PlayerColor = "RED";
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  @type("string") school: string = "";
  @type("string") discordName: string = "";
}

export type CollectibleType = "network" | "box" | "equilibrium" | "clone" | "vantage" | "galaxy" | "polyomino" | "checkpoint";

export type CollectibleColor = PlayerColor | "NEUTRAL";

export type CollectibleOrientation = 0 | 90 | 180 | 270;

export class Collectible extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") color: CollectibleColor = "RED";
  @type("string") id: string = "";
  @type("number") num: number = 0;
  @type("string") type: CollectibleType = "network";
  @type("boolean") isActivated: boolean = false;
  @type("boolean") isGold: boolean = false;
  @type("number") orientation: CollectibleOrientation = 0;
  @type("boolean") isFlipped: boolean = false;
  @type("string") shapeData: string = ""; // JSON string for polyomino shapes from level spec
  @type("number") score: number = 0;
}

export type EnemyPersonality = "red-avoiding" | "green-avoiding" | "blue-avoiding" | "same-color-avoiding" | "prismatic";

export class Enemy extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") id: string = "";
  @type("string") personality: EnemyPersonality = "red-avoiding";
}

export class GridCell extends Schema {
  @type("string") color: PlayerColor | undefined;
}

export class GameState extends Schema {
  @type("number") gridWidth: number = 10;
  @type("number") gridHeight: number = 8;

  @type({ map: Player }) players = new MapSchema<Player>();

  @type({ map: GridCell }) gridColors = new MapSchema<GridCell>();

  @type([Collectible]) collectibles = new ArraySchema<Collectible>();

  @type([Enemy]) enemies = new ArraySchema<Enemy>();

  @type({ map: "number" }) scores = new MapSchema<number>();

  @type("number") totalScore: number = 0;

  @type("number") highScore: number = 0;

  @type("boolean") gameStarted: boolean = false;

  @type("number") countdown: number = 0;

  @type("boolean") isGameOver: boolean = false;

  @type("number") timeRemaining: number = 30 * 60; // 30 minutes in seconds

  @type("number") stage: number = 1;

  @type(["number"]) stageThresholds = new ArraySchema<number>();

  @type("number") seed: number = 0;
}
