import { CollectibleType, CollectibleColor, CollectibleOrientation } from "../schema/GameState";

/**
 * Level Spec Format - Alternative to collectible-spawn.json
 *
 * This format allows specifying exact clue positions, orientations, and stages
 * instead of random spawning rules.
 */

// Type-specific data for clues
export interface PolyominoShape {
  x: number;
  y: number;
}

// Base clue definition
export interface LevelClue {
  type: CollectibleType;
  x: number;
  y: number;
  num: number;
  color: CollectibleColor;
  orientation?: CollectibleOrientation; // 0, 90, 180, 270
  isFlipped?: boolean;
  // Type-specific data
  shape?: PolyominoShape[]; // For polyomino clues
}

// Enemy definition
export interface LevelEnemy {
  x: number;
  y: number;
  personality?: "red-avoiding" | "green-avoiding" | "blue-avoiding" | "same-color-avoiding" | "prismatic";
}

// Stage definition
export interface LevelStage {
  clues: LevelClue[];
  enemies?: LevelEnemy[];
}

// Main level spec format
export interface LevelSpec {
  version: number;
  seed?: number;
  custom_target_scores: number[];
  stages: LevelStage[];
}

/**
 * Parse an Unreal export format into our LevelSpec format
 */
export function parseUnrealExport(data: any): LevelSpec {
  const colorMap: Record<number, CollectibleColor> = {
    0: "RED",
    1: "GREEN",
    2: "BLUE"
  };

  const clueTypeAliases: Record<string, CollectibleType> = {
    "square": "box",
  };

  const parseClueType = (unrealType: string): CollectibleType => {
    // Convert "EClueType::Network" to "network"
    const name = unrealType.replace("EClueType::", "").toLowerCase();
    return (clueTypeAliases[name] || name) as CollectibleType;
  };

  const stages: LevelStage[] = (data.clues_per_stage || []).map((stageClues: any[]) => ({
    clues: stageClues.map((clue: any) => {
      const type = parseClueType(clue.clue_type);

      // Square, clone, and vantage are specified as integers in Unreal but should be offset by 0.5
      const needsOffset = type === "box" || type === "clone" || type === "vantage";
      const offset = needsOffset ? 0.5 : 0;

      const parsed: LevelClue = {
        type,
        x: clue.x + offset,
        y: clue.y + offset,
        num: clue.num,
        color: colorMap[clue.color] || "NEUTRAL"
      };

      // Convert Unreal rotations (0-3) to orientation degrees (0, 90, 180, 270)
      // Rotations are anti-clockwise in 90 degree increments
      if (clue.rotations !== undefined) {
        parsed.orientation = -(clue.rotations * 90) as CollectibleOrientation;
      }

      // Convert Unreal is_mirrored to isFlipped
      if (clue.is_mirrored !== undefined) {
        parsed.isFlipped = clue.is_mirrored;
      }

      if (clue.shape) {
        parsed.shape = clue.shape;
      }

      return parsed;
    }),
    enemies: []
  }));

  return {
    version: data.version || 1,
    seed: data.seed,
    custom_target_scores: data.custom_target_scores || [],
    stages
  };
}
