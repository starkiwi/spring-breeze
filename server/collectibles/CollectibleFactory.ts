import { CollectibleType } from "../schema/GameState";
import { BaseCollectible } from "./BaseCollectible";
import { NetworkCollectible } from "./NetworkCollectible";
import { BoxCollectible } from "./BoxCollectible";
import { EquilibriumCollectible } from "./EquilibriumCollectible";
import { CloneCollectible } from "./CloneCollectible";
import { VantageCollectible } from "./VantageCollectible";
import { GalaxyCollectible } from "./GalaxyCollectible";
import { PolyominoCollectible } from "./PolyominoCollectible";
import { CheckpointCollectible } from "./CheckpointCollectible";

export class CollectibleFactory {
  private static handlers: Map<CollectibleType, BaseCollectible> = new Map<CollectibleType, BaseCollectible>([
    ["network", new NetworkCollectible()],
    ["box", new BoxCollectible()],
    ["equilibrium", new EquilibriumCollectible()],
    ["clone", new CloneCollectible()],
    ["vantage", new VantageCollectible()],
    ["galaxy", new GalaxyCollectible()],
    ["polyomino", new PolyominoCollectible()],
    ["checkpoint", new CheckpointCollectible()]
  ]);

  static getHandler(type: CollectibleType): BaseCollectible {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler found for collectible type: ${type}`);
    }
    return handler;
  }
}
