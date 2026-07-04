import { CollectibleType } from "../schema/GameState";

export interface CollectibleProperties {
  spawnsOnNodes: boolean;
  isNeutral: boolean;
}

export const COLLECTIBLE_PROPERTIES: Record<CollectibleType, CollectibleProperties> = {
  network: { spawnsOnNodes: true, isNeutral: false },
  equilibrium: { spawnsOnNodes: true, isNeutral: true },
  box: { spawnsOnNodes: false, isNeutral: false },
  clone: { spawnsOnNodes: false, isNeutral: true },
  vantage: { spawnsOnNodes: false, isNeutral: false },
  galaxy: { spawnsOnNodes: true, isNeutral: false },
  polyomino: { spawnsOnNodes: true, isNeutral: false },
  checkpoint: { spawnsOnNodes: true, isNeutral: false},
};

export interface CollectibleSpawnRule {
  clue_type: CollectibleType;
  first_stage: number;
  num_initial: number;
  num_subsequent: number;
}

export interface EnemySpawnRule {
  first_stage: number;
  num_initial: number;
  num_subsequent: number;
  personality?: "red-avoiding" | "green-avoiding" | "blue-avoiding" | "same-color-avoiding" | "prismatic";
}

export interface CollectibleSpawnConfig {
  seed?: number;
  custom_target_scores: number[];
  collectible_spawn_rules: CollectibleSpawnRule[];
  enemy_spawn_rules?: EnemySpawnRule[];
}
