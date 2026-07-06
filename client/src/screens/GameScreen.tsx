import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import * as Client from "colyseus.js";
import { toast } from "sonner";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import { Player } from "@/components/Player";
import { ParticleFloor } from "@/components/ParticleFloor";
import { CubeFrame } from "@/components/CubeFrame";
import { Hand } from "@/components/Hand";
import { EquilateralTriangle } from "@/components/EquilateralTriangle";
import { Compass } from "@/components/Compass";
import { GalaxyModel } from "@/components/GalaxyModel";
import { Polyomino } from "@/components/Polyomino";
import { EquilibriumCube } from "@/components/EquilibriumCube";
import { GoldAura } from "@/components/GoldAura";
import { Flower01 } from "@/components/Flower01";
import { FlowerBase } from "@/components/FlowerBase";
import { PulseRipple } from "@/components/game/PulseRipple";
import { FloatingScore } from "@/components/FloatingScore";
import { ClickHandler } from "@/components/ClickHandler";
import { LambdaSymbol } from "@/components/LambdaSymbol";
import { EnemyEntity } from "@/components/EnemyEntity";
import { Info, Scale, Settings, Volume2, VolumeX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSounds } from "@/hooks/use-sounds";
// Removed: PolarAmbientParticlesCanvas, NoiseBlobFieldCanvas — hidden behind opaque R3F canvas, wasted WebGL contexts
import { HudCornerLs, POLAR_HUD } from "@/components/ui/polar-chrome";
import { NoiseFieldOverlay, type NoiseFieldHandle } from "@/components/game/NoiseFieldOverlay";
import { StageAnnouncement } from "@/components/game/StageAnnouncement";
import { DevStageControls } from "@/components/game/DevStageControls";
import { GameControls } from "@/components/game/GameControls";
import { NebulaBackdrop } from "@/components/game/NebulaBackdrop";
import {
  getFloorTint,
  getPlayerDisplayLabel,
  getPlayerHex,
  getPlayerUiLabelHex,
  PLAYER_HEX,
  PLAYER_HEX_LOWER,
} from "@/constants/playerColors";

// Types
type PlayerColor = "RED" | "GREEN" | "BLUE";
type ClueColorLower = "red" | "green" | "blue";
type CollectibleType = "network" | "box" | "equilibrium" | "clone" | "vantage" | "galaxy" | "polyomino" | "checkpoint";
type CollectibleOrientation = 0 | 90 | 180 | 270;

interface PlayerState {
  x: number;
  y: number;
  color: PlayerColor;
  sessionId: string;
  name: string;
  school: string;
  discordName: string;
}

interface Collectible {
  x: number;
  y: number;
  color: string;
  id: string;
  num: number;
  type: CollectibleType;
  isActivated: boolean;
  isGold: boolean;
  orientation: CollectibleOrientation;
  isFlipped: boolean;
  score: number;
}

interface EnemyState {
  x: number;
  y: number;
  id: string;
  personality: string;
}

interface Ping {
  id: string;
  x: number;
  y: number;
  timestamp: number;
  color: PlayerColor;
}

const COLOR_MAP_LOWER: Record<PlayerColor, ClueColorLower> = {
  RED: "red",
  GREEN: "green",
  BLUE: "blue",
};

/** Stage score bar fill (bottom → top), aligned with board color identity. */
const NEUTRAL_BAR_GRADIENT =
  "linear-gradient(to top, #1e293b 0%, #334155 12%, #475569 24%, #64748b 38%, #94a3b8 54%, #cbd5e1 68%, #e2e8f0 82%, #f1f5f9 92%, #ffffff 100%)";

const SCORE_BAR_GRADIENT: Record<PlayerColor, string> = {
  RED: NEUTRAL_BAR_GRADIENT,
  GREEN: NEUTRAL_BAR_GRADIENT,
  BLUE: NEUTRAL_BAR_GRADIENT,
};

const CONTROL_KEYS = {
  up: ["ArrowUp", "w", "W"],
  down: ["ArrowDown", "s", "S"],
  left: ["ArrowLeft", "a", "A"],
  right: ["ArrowRight", "d", "D"],
};

const SPACING = 2.5;

// Error boundary to catch silent Canvas/Three.js crashes
class CanvasErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Canvas Error Boundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-canvas">
          <div className="text-center">
            <p className="text-slate-400 text-sm mb-3">3D rendering failed</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-none border border-emerald-500/60 bg-emerald-950/40 px-4 py-2 font-montreal text-xs uppercase tracking-wider text-emerald-200 transition hover:border-emerald-400/80 hover:bg-emerald-900/50"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Defers EffectComposer mount until canvas has real dimensions,
// preventing Bloom from creating 0x0 framebuffers inside iframes
const DeferredEffects = () => {
  const { size } = useThree();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (size.width > 0 && size.height > 0) setReady(true);
  }, [size.width, size.height]);

  if (!ready) return null;
  return (
    <EffectComposer>
      <Bloom intensity={0.75} luminanceThreshold={0.5} luminanceSmoothing={0.9} mipmapBlur />
    </EffectComposer>
  );
};

// Calculate 2D camera position (top-down view)
const get2DCameraPosition = (gridWidth: number, gridHeight: number): [number, number, number] => {
  const boardSize = Math.max(gridWidth, gridHeight) * SPACING;
  // Top-down view: camera directly above
  const height = boardSize * 1.5;
  return [0, height, 0];
};

// Calculates the target ortho zoom to fit the board in the viewport
const calcBoardZoom = (gridWidth: number, gridHeight: number, spacing: number, viewportHeight: number) => {
  const boardSize = Math.max(gridWidth, gridHeight) * spacing;
  if (boardSize === 0) return 1000;
  const padding = 1.3;
  return viewportHeight / (boardSize * padding);
};

// Sets camera position + zoom once on first valid data,
// then snaps zoom on grid dimension changes (stage-up).
const SmoothZoom = ({
  gridWidth,
  gridHeight,
  spacing,
}: {
  gridWidth: number;
  gridHeight: number;
  spacing: number;
}) => {
  const { camera, size } = useThree();
  const initialized = useRef(false);
  const prevGrid = useRef({ w: 0, h: 0, vh: 0 });

  useFrame(() => {
    if (size.height === 0 || gridWidth <= 0 || gridHeight <= 0) return;
    const ortho = camera as THREE.OrthographicCamera;
    const zoom = calcBoardZoom(gridWidth, gridHeight, spacing, size.height);
    if (!isFinite(zoom) || zoom <= 0) return;

    const needsUpdate =
      !initialized.current ||
      gridWidth !== prevGrid.current.w ||
      gridHeight !== prevGrid.current.h ||
      size.height !== prevGrid.current.vh;

    if (!needsUpdate) return;

    // Position camera directly above the board center, looking straight down
    const pos = get2DCameraPosition(gridWidth, gridHeight);
    ortho.position.set(pos[0], pos[1], pos[2]);
    // Set rotation explicitly for top-down view (avoid lookAt gimbal lock)
    ortho.rotation.set(-Math.PI / 2, 0, 0);
    ortho.zoom = zoom;
    ortho.updateProjectionMatrix();

    prevGrid.current = { w: gridWidth, h: gridHeight, vh: size.height };
    initialized.current = true;
  });

  return null;
};

// Connection Lines Component — batched into a single InstancedMesh
const colorMap: Record<string, THREE.Color> = {
  red: new THREE.Color(PLAYER_HEX_LOWER.red),
  blue: new THREE.Color(PLAYER_HEX_LOWER.blue),
  green: new THREE.Color(PLAYER_HEX_LOWER.green),
};

// Shared geometry for all line segments (thin cylinder along Y)
// Quaternions for horizontal (along X) and vertical (along Z) lines
const quatHorizontal = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(1, 0, 0),
);
const quatVertical = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
);

const lineVertexShader = `
  attribute vec3 instanceColor;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const lineFragmentShader = `
  uniform float uTime;
  uniform float uRepeats;
  varying vec2 vUv;
  varying vec3 vColor;

  void main() {
    float t = -uTime * 1.0;
    float progress = vUv.y * uRepeats + t;
    float dash = step(0.5, fract(progress));
    if (dash < 0.5) discard;
    gl_FragColor = vec4(vColor * 0.4, 1.0);
  }
`;

const ConnectionLines = ({ nodeStates, gridWidth, gridHeight }: { nodeStates: (string | null)[][], gridWidth: number, gridHeight: number }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const lines = useMemo(() => {
    const items: { px: number; pz: number; horizontal: boolean; color: string }[] = [];
    const offsetX = (gridWidth - 1) / 2;
    const offsetZ = (gridHeight - 1) / 2;

    for (let x = 0; x < gridWidth; x++) {
      for (let z = 0; z < gridHeight; z++) {
        const color = nodeStates[x][z];
        if (!color || color === "gray") continue;

        if (x < gridWidth - 1 && nodeStates[x + 1][z] === color) {
          items.push({
            px: (x + 0.5 - offsetX) * SPACING,
            pz: (z - offsetZ) * SPACING,
            horizontal: true,
            color,
          });
        }
        if (z < gridHeight - 1 && nodeStates[x][z + 1] === color) {
          items.push({
            px: (x - offsetX) * SPACING,
            pz: (z + 0.5 - offsetZ) * SPACING,
            horizontal: false,
            color,
          });
        }
      }
    }
    return items;
  }, [nodeStates, gridWidth, gridHeight]);

  const maxCount = gridWidth * gridHeight * 2;

  const colorArray = useMemo(() => new Float32Array(maxCount * 3), [maxCount]);

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uRepeats: { value: SPACING * 4.0 },
  }), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      dummy.position.set(l.px, -2.5, l.pz);
      dummy.quaternion.copy(l.horizontal ? quatHorizontal : quatVertical);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(colorMap[l.color] ?? colorMap.red);
      colorArray[i * 3] = col.r;
      colorArray[i * 3 + 1] = col.g;
      colorArray[i * 3 + 2] = col.b;
    }

    mesh.count = lines.length;
    mesh.instanceMatrix.needsUpdate = true;

    const colorAttr = mesh.geometry.getAttribute("instanceColor") as THREE.InstancedBufferAttribute;
    if (colorAttr) colorAttr.needsUpdate = true;
  }, [lines, colorArray]);

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, maxCount]}>
      <cylinderGeometry args={[0.04, 0.04, SPACING, 6]}>
        <instancedBufferAttribute attach="attributes-instanceColor" args={[colorArray, 3]} />
      </cylinderGeometry>
      <shaderMaterial
        vertexShader={lineVertexShader}
        fragmentShader={lineFragmentShader}
        uniforms={uniforms}
        vertexColors={true}
        transparent={true}
        side={THREE.DoubleSide}
      />
    </instancedMesh>
  );
};

// Lambda Component (static)
const SpinningLambda = ({ color, connected }: { color: string; connected: boolean }) => {
  return (
    <group>
      <LambdaSymbol color={color} scale={1.0} connected={connected} />
    </group>
  );
};

interface GameScreenProps {
  room: Client.Room | null;
  players: Map<string, PlayerState>;
  gridColors: Map<string, PlayerColor>;
  collectibles: Collectible[];
  enemies: EnemyState[];
  gridWidth: number;
  gridHeight: number;
  myColor: PlayerColor | null;
  isSoloMode: boolean;
  scores: Record<PlayerColor, number>;
  totalScore: number;
  highScore: number;
  stage: number;
  stageThresholds: number[];
  timeRemaining: number;
  isDevMode: boolean;
  seed: number;
  isSpectator?: boolean;
  isGameOver?: boolean;
  countdown?: number;
  bgMusicVolume?: number;
  onBgMusicVolumeChange?: (volume: number) => void;
  onGameAbandoned?: () => void;
  challengeName?: string;
}

/** Horizontal slider styled to match the in-game score bar (cyan frame + navy→white gradient fill). */
const PolarSlider = ({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative h-3 min-w-0 flex-1">
      <div
        className="absolute inset-0 overflow-hidden rounded-none border border-solid bg-white/[0.04] ring-1 ring-inset ring-white/[0.05] backdrop-blur-[4px]"
        style={{
          borderColor: POLAR_HUD.barBorder,
          boxShadow: `inset 0 0 20px ${POLAR_HUD.barInset}`,
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 3px)",
          }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to right, #1e293b 0%, #2d3f56 8%, #3e5570 18%, #5a7a96 30%, #7da3bf 44%, #a5cfe4 58%, #c8e6f5 72%, #e0f2fe 84%, #f0f9ff 93%, #ffffff 100%)",
            }}
          />
          <div
            className="absolute inset-x-0 top-0 h-[40%] opacity-30"
            style={{
              background: "linear-gradient(to bottom, rgba(255,255,255,0.15), transparent)",
            }}
            aria-hidden
          />
          <div
            className="absolute inset-y-0 right-0 w-3"
            style={{
              background:
                "linear-gradient(to left, rgba(186,230,253,0.6), rgba(186,230,253,0.15) 40%, transparent)",
            }}
            aria-hidden
          />
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={ariaLabel}
      />
    </div>
  );
};

export const GameScreen = ({
  room,
  players,
  gridColors,
  collectibles,
  enemies,
  gridWidth,
  gridHeight,
  myColor,
  isSoloMode,
  scores,
  totalScore,
  highScore,
  stage,
  stageThresholds,
  timeRemaining,
  isDevMode,
  seed,
  isSpectator = false,
  isGameOver = false,
  countdown = 0,
  bgMusicVolume,
  onBgMusicVolumeChange,
  onGameAbandoned,
  challengeName,
}: GameScreenProps) => {
  const { play: playSound, sfxVolume, setSfxVolume } = useSounds();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsExiting, setSettingsExiting] = useState(false);
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [pings, setPings] = useState<Ping[]>([]);
  const [clearBoardVoteActive, setClearBoardVoteActive] = useState(false);
  const [clearBoardVoteCount, setClearBoardVoteCount] = useState(0);
  const [clearBoardExpiresAt, setClearBoardExpiresAt] = useState<number | null>(null);
  const [clearBoardInitiatorColor, setClearBoardInitiatorColor] = useState<PlayerColor | null>(null);
  const [clearBoardSecondsLeft, setClearBoardSecondsLeft] = useState(0);
  const [clearBoardBannerVisible, setClearBoardBannerVisible] = useState(false);
  const clearBoardBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clearBoardExpiredVisible, setClearBoardExpiredVisible] = useState(false);
  const clearBoardExpiredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasVotedClearBoard, setHasVotedClearBoard] = useState(false);
  const [abandonVoteActive, setAbandonVoteActive] = useState(false);
  const [abandonVoteCount, setAbandonVoteCount] = useState(0);
  const [abandonExpiresAt, setAbandonExpiresAt] = useState<number | null>(null);
  const [abandonInitiatorColor, setAbandonInitiatorColor] = useState<PlayerColor | null>(null);
  const [abandonSecondsLeft, setAbandonSecondsLeft] = useState(0);
  const [abandonBannerVisible, setAbandonBannerVisible] = useState(false);
  const abandonBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [abandonExpiredVisible, setAbandonExpiredVisible] = useState(false);
  const abandonExpiredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasVotedAbandon, setHasVotedAbandon] = useState(false);
  const [rippleTrigger, setRippleTrigger] = useState(0);
  const [barBloom, setBarBloom] = useState(0); // 0 = off, >0 = intensity
  const [controlsOpen, setControlsOpen] = useState(false);
  const [predictedPos, setPredictedPos] = useState<{ x: number, y: number } | null>(null);
  const [predictedGridColors, setPredictedGridColors] = useState<Map<string, PlayerColor | "clear">>(new Map());
  const settingsCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SETTINGS_CLOSE_MS = 300;

  const openSettings = () => {
    if (settingsCloseTimerRef.current != null) {
      clearTimeout(settingsCloseTimerRef.current);
      settingsCloseTimerRef.current = null;
    }
    setSettingsExiting(false);
    setSettingsOpen(true);
  };

  const requestCloseSettings = () => {
    if (settingsCloseTimerRef.current != null) return;
    setSettingsExiting(true);
    settingsCloseTimerRef.current = setTimeout(() => {
      settingsCloseTimerRef.current = null;
      setSettingsOpen(false);
      setSettingsExiting(false);
    }, SETTINGS_CLOSE_MS);
  };

  const pendingInputsRef = useRef<Map<number, { x: number, y: number }>>(new Map());
  const seqCounterRef = useRef(0);
  const lastRepeatTimeRef = useRef(0);
  const prevStageRef = useRef(stage);
  const onGameAbandonedRef = useRef(onGameAbandoned);
  onGameAbandonedRef.current = onGameAbandoned;

  // Floating score animations
  const [floatingScores, setFloatingScores] = useState<Array<{
    id: string;
    collectibleId: string;
    position: [number, number, number];
    score: number;
    timestamp: number;
  }>>([]);
  const prevScoresRef = useRef<Map<string, number>>(new Map());
  const collectiblesRef = useRef(collectibles);
  collectiblesRef.current = collectibles;
  const collectiblesScoreSig = useMemo(
    () => collectibles.map((c) => `${c.id}:${c.score}`).join("|"),
    [collectibles],
  );

  // Score burst overlay ref
  // Noise field overlay ref (flashes on stage change)
  const noiseFieldRef = useRef<NoiseFieldHandle>(null);

  // Dev: client-side stage override for effects testing (does NOT affect game)
  const [fakeStage, setFakeStage] = useState<number | null>(null);
  const effectiveStage = fakeStage ?? stage;

  // Main score bar floating score
  const [mainScoreFloating, setMainScoreFloating] = useState<{
    score: number;
    id: string;
  } | null>(null);
  const prevTotalScoreRef = useRef(totalScore);

  const currentStageThreshold = stage < 8 && stageThresholds.length > 0
    ? stageThresholds[stage - 1]
    : (stageThresholds[stageThresholds.length - 1] || 0);

  const scoreBarFillPercent = Math.min(
    (totalScore / (currentStageThreshold || 1)) * 100,
    100,
  );
  const highScoreBarPercent = Math.min(
    (highScore / (currentStageThreshold || 1)) * 100,
    100,
  );

  const scoreBarGradient = useMemo(() => {
    const playerArray = Array.from(players.values());
    const c: PlayerColor = isSoloMode
      ? playerArray[activePlayerIndex]?.color ?? "RED"
      : myColor ?? "RED";
    return SCORE_BAR_GRADIENT[c];
  }, [isSoloMode, myColor, activePlayerIndex, players]);

  const localPlayerDisplayName = useMemo(() => {
    if (!room) return null;
    const me = Array.from(players.values()).find((p) => p.sessionId === room.sessionId);
    const n = me?.name?.trim();
    return n && n.length > 0 ? n : null;
  }, [room, players]);

  const clearBoardInitiatorName = useMemo(() => {
    if (!clearBoardInitiatorColor) return null;
    const initiator = Array.from(players.values()).find((p) => p.color === clearBoardInitiatorColor);
    const trimmed = initiator?.name?.trim();
    return trimmed && trimmed.length > 0
      ? trimmed
      : getPlayerDisplayLabel(clearBoardInitiatorColor);
  }, [clearBoardInitiatorColor, players]);

  const abandonInitiatorName = useMemo(() => {
    if (!abandonInitiatorColor) return null;
    const initiator = Array.from(players.values()).find((p) => p.color === abandonInitiatorColor);
    const trimmed = initiator?.name?.trim();
    return trimmed && trimmed.length > 0
      ? trimmed
      : getPlayerDisplayLabel(abandonInitiatorColor);
  }, [abandonInitiatorColor, players]);

  useEffect(() => {
    return () => {
      if (settingsCloseTimerRef.current != null) {
        clearTimeout(settingsCloseTimerRef.current);
        settingsCloseTimerRef.current = null;
      }
    };
  }, []);

  // Clear predicted grid colors that have been confirmed by server
  useEffect(() => {
    if (predictedGridColors.size === 0) return;
    setPredictedGridColors(prev => {
      const remaining = new Map<string, PlayerColor | "clear">();
      for (const [key, value] of prev) {
        if (value === "clear") {
          if (gridColors.has(key)) remaining.set(key, value); // server hasn't confirmed clear yet
        } else {
          if (gridColors.get(key) !== value) remaining.set(key, value); // server hasn't confirmed paint yet
        }
      }
      return remaining.size !== prev.size ? remaining : prev;
    });
  }, [gridColors]);

  // Listen for room messages
  useEffect(() => {
    if (!room) return;

    const handlePing = (message: { x: number; y: number; color: PlayerColor }) => {
      playSound("ping");
      const now = Date.now();
      const newPing: Ping = {
        id: crypto.randomUUID(),
        x: message.x,
        y: message.y,
        timestamp: now,
        color: message.color,
      };
      setPings((prev) => [...prev, newPing]);
    };

    const handleClearBoardVoteStarted = (message: { initiatorColor: PlayerColor; expiresAt: number }) => {
      setClearBoardVoteActive(true);
      setClearBoardExpiresAt(message.expiresAt);
      setClearBoardVoteCount(1);
      setClearBoardInitiatorColor(message.initiatorColor);
      setClearBoardExpiredVisible(false);
      if (clearBoardExpiredTimerRef.current) {
        clearTimeout(clearBoardExpiredTimerRef.current);
        clearBoardExpiredTimerRef.current = null;
      }
      setClearBoardBannerVisible(true);
      if (clearBoardBannerTimerRef.current) clearTimeout(clearBoardBannerTimerRef.current);
      clearBoardBannerTimerRef.current = setTimeout(() => {
        setClearBoardBannerVisible(false);
        clearBoardBannerTimerRef.current = null;
      }, 2200);
    };

    const handleClearBoardVoteUpdate = (message: { voterColor: PlayerColor; voteCount: number }) => {
      setClearBoardVoteCount(message.voteCount);
      playSound("vote");
    };

    const handleClearBoardVoteExpired = () => {
      setClearBoardVoteActive(false);
      setClearBoardExpiresAt(null);
      setClearBoardVoteCount(0);
      setClearBoardInitiatorColor(null);
      setHasVotedClearBoard(false);
      setClearBoardExpiredVisible(true);
      if (clearBoardExpiredTimerRef.current) clearTimeout(clearBoardExpiredTimerRef.current);
      clearBoardExpiredTimerRef.current = setTimeout(() => {
        setClearBoardExpiredVisible(false);
        clearBoardExpiredTimerRef.current = null;
      }, 3000);
    };

    const handleBoardCleared = () => {
      setClearBoardVoteActive(false);
      setClearBoardExpiresAt(null);
      setClearBoardVoteCount(0);
      setClearBoardInitiatorColor(null);
      setHasVotedClearBoard(false);
      playSound("clear");
      toast.success("Board cleared!");
    };

    const handleAbandonVoteStarted = (message: { initiatorColor: string; expiresAt: number }) => {
      setAbandonVoteActive(true);
      setAbandonExpiresAt(message.expiresAt);
      setAbandonVoteCount(1);
      setAbandonInitiatorColor(message.initiatorColor as PlayerColor);
      setAbandonExpiredVisible(false);
      if (abandonExpiredTimerRef.current) {
        clearTimeout(abandonExpiredTimerRef.current);
        abandonExpiredTimerRef.current = null;
      }
      setAbandonBannerVisible(true);
      if (abandonBannerTimerRef.current) clearTimeout(abandonBannerTimerRef.current);
      abandonBannerTimerRef.current = setTimeout(() => {
        setAbandonBannerVisible(false);
        abandonBannerTimerRef.current = null;
      }, 2200);
    };

    const handleAbandonVoteUpdate = (message: { voterColor: string; voteCount: number }) => {
      setAbandonVoteCount(message.voteCount);
      playSound("vote");
    };

    const handleAbandonVoteExpired = () => {
      setAbandonVoteActive(false);
      setAbandonExpiresAt(null);
      setAbandonVoteCount(0);
      setAbandonInitiatorColor(null);
      setHasVotedAbandon(false);
      setAbandonExpiredVisible(true);
      if (abandonExpiredTimerRef.current) clearTimeout(abandonExpiredTimerRef.current);
      abandonExpiredTimerRef.current = setTimeout(() => {
        setAbandonExpiredVisible(false);
        abandonExpiredTimerRef.current = null;
      }, 3000);
    };

    const handleGameAbandoned = () => {
      setAbandonVoteActive(false);
      setAbandonExpiresAt(null);
      setAbandonVoteCount(0);
      setAbandonInitiatorColor(null);
      setHasVotedAbandon(false);
      playSound("abandon");
      onGameAbandonedRef.current?.();
    };

    const handleMoveAck = (message: { seq: number; x: number; y: number }) => {
      // Remove this input from pending
      pendingInputsRef.current.delete(message.seq);

      // If no more pending inputs, sync to server position
      if (pendingInputsRef.current.size === 0) {
        setPredictedPos({ x: message.x, y: message.y });
      }
      // If still pending inputs, keep current predicted position (already calculated)
    };

    const offPing = room.onMessage("ping", handlePing);
    const offMoveAck = room.onMessage("moveAck", handleMoveAck);
    const offClearStart = room.onMessage("clearBoardVoteStarted", handleClearBoardVoteStarted);
    const offClearUpdate = room.onMessage("clearBoardVoteUpdate", handleClearBoardVoteUpdate);
    const offClearExpired = room.onMessage("clearBoardVoteExpired", handleClearBoardVoteExpired);
    const offBoardCleared = room.onMessage("boardCleared", handleBoardCleared);
    const offAbandonStart = room.onMessage("abandonGameVoteStarted", handleAbandonVoteStarted);
    const offAbandonUpdate = room.onMessage("abandonGameVoteUpdate", handleAbandonVoteUpdate);
    const offAbandonExpired = room.onMessage("abandonGameVoteExpired", handleAbandonVoteExpired);
    const offGameAbandoned = room.onMessage("gameAbandoned", handleGameAbandoned);

    return () => {
      [
        offPing,
        offMoveAck,
        offClearStart,
        offClearUpdate,
        offClearExpired,
        offBoardCleared,
        offAbandonStart,
        offAbandonUpdate,
        offAbandonExpired,
        offGameAbandoned,
      ].forEach((off) => {
        if (typeof off === "function") off();
      });
    };
  }, [room]);

  // Trigger ripple + effects on stage changes (works with both real and fake stage)
  useEffect(() => {
    if (effectiveStage !== prevStageRef.current) {
      prevStageRef.current = effectiveStage;
      setRippleTrigger(prev => prev + 1);
      // Bloom pulse on score bar — fades out over 1.5s via CSS transition
      const bloomStrength = 0.3 + (effectiveStage / 8) * 0.7; // 0.3 → 1.0
      setBarBloom(bloomStrength);
      setTimeout(() => setBarBloom(0), 100); // trigger fade-out after paint
      // Flash noise overlay — stage 1 very subtle, ramps up gradually
      const stageIntensity = 0.07 + (effectiveStage / 8) * 0.33; // 0.07 → 0.4
      const stageDuration = 0.6 + (effectiveStage / 8) * 0.8;   // 0.6s → 1.4s
      noiseFieldRef.current?.flash(stageDuration, stageIntensity);
    }
  }, [effectiveStage]);

  // Log seed in dev mode
  useEffect(() => {
    if (isDevMode && seed) {
      console.log(`[Dev Mode] Seed: ${seed}`);
    }
  }, [isDevMode, seed]);

  // Handle clear board vote expiration timer + countdown
  useEffect(() => {
    if (!clearBoardExpiresAt) {
      setClearBoardSecondsLeft(0);
      return;
    }

    const tick = () => {
      const remainingMs = clearBoardExpiresAt - Date.now();
      if (remainingMs <= 0) {
        setClearBoardVoteActive(false);
        setClearBoardExpiresAt(null);
        setClearBoardVoteCount(0);
        setClearBoardInitiatorColor(null);
        setHasVotedClearBoard(false);
        setClearBoardSecondsLeft(0);
        setClearBoardExpiredVisible(true);
        if (clearBoardExpiredTimerRef.current) clearTimeout(clearBoardExpiredTimerRef.current);
        clearBoardExpiredTimerRef.current = setTimeout(() => {
          setClearBoardExpiredVisible(false);
          clearBoardExpiredTimerRef.current = null;
        }, 3000);
      } else {
        setClearBoardSecondsLeft(Math.ceil(remainingMs / 1000));
      }
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [clearBoardExpiresAt]);

  // Handle abandon vote expiration timer + countdown
  useEffect(() => {
    if (!abandonExpiresAt) {
      setAbandonSecondsLeft(0);
      return;
    }

    const tick = () => {
      const remainingMs = abandonExpiresAt - Date.now();
      if (remainingMs <= 0) {
        setAbandonVoteActive(false);
        setAbandonExpiresAt(null);
        setAbandonVoteCount(0);
        setAbandonInitiatorColor(null);
        setHasVotedAbandon(false);
        setAbandonSecondsLeft(0);
        setAbandonExpiredVisible(true);
        if (abandonExpiredTimerRef.current) clearTimeout(abandonExpiredTimerRef.current);
        abandonExpiredTimerRef.current = setTimeout(() => {
          setAbandonExpiredVisible(false);
          abandonExpiredTimerRef.current = null;
        }, 3000);
      } else {
        setAbandonSecondsLeft(Math.ceil(remainingMs / 1000));
      }
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [abandonExpiresAt]);

  // Clean up the banner timers on unmount
  useEffect(() => {
    return () => {
      if (clearBoardBannerTimerRef.current) {
        clearTimeout(clearBoardBannerTimerRef.current);
        clearBoardBannerTimerRef.current = null;
      }
      if (abandonBannerTimerRef.current) {
        clearTimeout(abandonBannerTimerRef.current);
        abandonBannerTimerRef.current = null;
      }
      if (clearBoardExpiredTimerRef.current) {
        clearTimeout(clearBoardExpiredTimerRef.current);
        clearBoardExpiredTimerRef.current = null;
      }
      if (abandonExpiredTimerRef.current) {
        clearTimeout(abandonExpiredTimerRef.current);
        abandonExpiredTimerRef.current = null;
      }
    };
  }, []);

  // Initialize predicted position when we know our player
  useEffect(() => {
    if (players.size > 0 && !predictedPos) {
      if (isSoloMode) {
        // In solo mode, use the active player's position
        const playerArray = Array.from(players.values());
        if (playerArray[activePlayerIndex]) {
          setPredictedPos({ x: playerArray[activePlayerIndex].x, y: playerArray[activePlayerIndex].y });
        }
      } else if (myColor) {
        // In multiplayer, use our player's position
        const localPlayer = Array.from(players.values()).find(p => p.color === myColor);
        if (localPlayer) {
          setPredictedPos({ x: localPlayer.x, y: localPlayer.y });
        }
      }
    }
  }, [myColor, players, isSoloMode, predictedPos, activePlayerIndex]);

  // Reset prediction when switching players in solo mode (only on activePlayerIndex change)
  const prevActivePlayerIndexRef = useRef(activePlayerIndex);
  useEffect(() => {
    if (isSoloMode && prevActivePlayerIndexRef.current !== activePlayerIndex) {
      prevActivePlayerIndexRef.current = activePlayerIndex;
      const playerArray = Array.from(players.values());
      if (playerArray[activePlayerIndex]) {
        // Clear pending inputs and reset to new active player's position
        pendingInputsRef.current.clear();
        setPredictedPos({ x: playerArray[activePlayerIndex].x, y: playerArray[activePlayerIndex].y });
      }
    }
  }, [activePlayerIndex, isSoloMode, players]);

  // Keyboard controls
  useEffect(() => {
    if (!room || isSpectator || countdown > 0 || isGameOver) return;

    const REPEAT_INTERVAL = 1000 / 5; // 5 times per second

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) {
        const now = performance.now();
        if (now - lastRepeatTimeRef.current < REPEAT_INTERVAL) return;
        lastRepeatTimeRef.current = now;
      }
      if (isSoloMode && e.key === "Tab") {
        e.preventDefault();
        const playerArray = Array.from(players.values());
        if (playerArray.length > 0) {
          const newIndex = (activePlayerIndex + 1) % playerArray.length;
          const newPlayer = playerArray[newIndex];
          // Update both atomically to avoid stale predictedPos on the transition frame
          pendingInputsRef.current.clear();
          setPredictedPos({ x: newPlayer.x, y: newPlayer.y });
          setActivePlayerIndex(newIndex);
        }
        return;
      }

      // Dev mode: 1/2/3 to switch to red/green/blue player
      if (isDevMode && isSoloMode && (e.key === "1" || e.key === "2" || e.key === "3")) {
        const colorMap: Record<string, PlayerColor> = { "1": "RED", "2": "GREEN", "3": "BLUE" };
        const targetColor = colorMap[e.key];
        const playerArray = Array.from(players.values());
        const targetIndex = playerArray.findIndex(p => p.color === targetColor);
        if (targetIndex !== -1 && targetIndex !== activePlayerIndex) {
          const newPlayer = playerArray[targetIndex];
          pendingInputsRef.current.clear();
          setPredictedPos({ x: newPlayer.x, y: newPlayer.y });
          setActivePlayerIndex(targetIndex);
        }
        return;
      }

      let direction: "up" | "down" | "left" | "right" | null = null;
      if (CONTROL_KEYS.up.includes(e.key)) direction = "up";
      else if (CONTROL_KEYS.down.includes(e.key)) direction = "down";
      else if (CONTROL_KEYS.left.includes(e.key)) direction = "left";
      else if (CONTROL_KEYS.right.includes(e.key)) direction = "right";

      if (direction) {
        e.preventDefault();

        const playerArray = Array.from(players.values());
        const currentPlayer = isSoloMode
          ? playerArray[activePlayerIndex]
          : playerArray.find(p => p.color === myColor);
        const activeColor = currentPlayer?.color;

        // Immediately predict local movement
        if (predictedPos && room) {
          const MAX_GRID = 26;
          const center = Math.floor(MAX_GRID / 2);
          const halfWidth = Math.floor(gridWidth / 2);
          const halfHeight = Math.floor(gridHeight / 2);
          const minX = center - halfWidth;
          const maxX = center + halfWidth - 1;
          const minY = center - halfHeight;
          const maxY = center + halfHeight - 1;

          let newX = predictedPos.x;
          let newY = predictedPos.y;
          switch (direction) {
            case "up": newY = Math.max(minY, newY - 1); break;
            case "down": newY = Math.min(maxY, newY + 1); break;
            case "left": newX = Math.max(minX, newX - 1); break;
            case "right": newX = Math.min(maxX, newX + 1); break;
          }

          // Check for collision with other players
          const isBlocked = playerArray.some(
            p => p !== currentPlayer && p.x === newX && p.y === newY
          );

          if (!isBlocked) {
            playSound("move");
            // Track this pending input
            const seq = ++seqCounterRef.current;
            pendingInputsRef.current.set(seq, { x: newX, y: newY });
            setPredictedPos({ x: newX, y: newY });

            // Send to server with seq (include targetColor in solo mode)
            room.send("move", {
              direction,
              seq,
              ...(isSoloMode && activeColor ? { targetColor: activeColor } : {}),
            });
            return; // Already sent
          }
        }

        // Fallback: Send with seq but without local prediction (blocked move or no predicted pos yet)
        const seq = ++seqCounterRef.current;
        // Track pending so ack handler can sync position when it returns
        pendingInputsRef.current.set(seq, { x: -1, y: -1 }); // Placeholder - ack will provide real position
        room.send("move", {
          direction,
          seq,
          ...(isSoloMode && currentPlayer ? { targetColor: currentPlayer.color } : {}),
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [room, myColor, isSoloMode, activePlayerIndex, players, gridWidth, gridHeight, predictedPos, isDevMode, isSpectator, countdown, isGameOver]);

  // Transform Grid Colors to Node States
  const nodeStates = useMemo(() => {
    const MAX_GRID = 26;
    const center = Math.floor(MAX_GRID / 2);
    const halfWidth = Math.floor(gridWidth / 2);
    const halfHeight = Math.floor(gridHeight / 2);
    const minX = center - halfWidth;
    const minY = center - halfHeight;

    const states = Array(gridWidth).fill(null).map(() => Array(gridHeight).fill(null));
    gridColors.forEach((color, key) => {
      const [absX, absY] = key.split(",").map(Number);
      const x = absX - minX;
      const y = absY - minY;
      if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
        states[x][y] = COLOR_MAP_LOWER[color];
      }
    });
    // Apply client-side predictions on top of server state
    predictedGridColors.forEach((value, key) => {
      const [absX, absY] = key.split(",").map(Number);
      const x = absX - minX;
      const y = absY - minY;
      if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
        states[x][y] = value === "clear" ? null : COLOR_MAP_LOWER[value];
      }
    });
    return states;
  }, [gridColors, predictedGridColors, gridWidth, gridHeight]);

  // Detect score changes and trigger floating score animations (sig avoids work every Colyseus tick).
  useEffect(() => {
    const list = collectiblesRef.current;
    const newFloatingScores: typeof floatingScores = [];

    // Helper to calculate visual position
    const calculateVisualPos = (absX: number, absY: number, height: number = 0) => {
      const MAX_GRID = 26;
      const center = Math.floor(MAX_GRID / 2);
      const halfWidth = Math.floor(gridWidth / 2);
      const halfHeight = Math.floor(gridHeight / 2);
      const minX = center - halfWidth;
      const minY = center - halfHeight;

      const x = absX - minX;
      const y = absY - minY;

      const offsetX = (gridWidth - 1) / 2;
      const offsetY = (gridHeight - 1) / 2;
      return [
        (x - offsetX) * SPACING,
        height,
        (y - offsetY) * SPACING
      ] as [number, number, number];
    };

    list.forEach((collectible) => {
      const prevScore = prevScoresRef.current.get(collectible.id) || 0;
      const currentScore = collectible.score || 0;

      // Trigger animation when score changes
      if (currentScore !== prevScore) {
        const scoreDiff = currentScore - prevScore;
        const pos = calculateVisualPos(collectible.x, collectible.y, -2.0);

        const ts = Date.now();
        newFloatingScores.push({
          id: `${collectible.id}-${ts}-${crypto.randomUUID()}`,
          collectibleId: collectible.id,
          position: [pos[0] + 0.5, pos[1], pos[2] - 0.5], // Top-right offset (right and back)
          score: scoreDiff,
          timestamp: ts,
        });

        prevScoresRef.current.set(collectible.id, currentScore);
      }
    });

    if (newFloatingScores.length > 0) {
      const MAX_FLOATING = 14;
      setFloatingScores((prev) =>
        [...prev, ...newFloatingScores].slice(-MAX_FLOATING),
      );

    }
  }, [collectiblesScoreSig, gridWidth, gridHeight, myColor]);

  // Play gold sound when a collectible becomes gold
  const prevGoldRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    collectibles.forEach((c) => {
      const wasGold = prevGoldRef.current.get(c.id) ?? false;
      if (!wasGold && c.isGold) {
        playSound("gold");
      }
      prevGoldRef.current.set(c.id, c.isGold);
    });
  }, [collectibles]);

  // Detect total score changes for main score bar animation
  useEffect(() => {
    const prevScore = prevTotalScoreRef.current;
    const currentScore = totalScore;

    if (currentScore !== prevScore) {
      const scoreDiff = currentScore - prevScore;
      playSound(scoreDiff > 0 ? "activate" : "deactivate");
      setMainScoreFloating({
        score: scoreDiff,
        id: `main-score-${Date.now()}-${crypto.randomUUID()}`,
      });

      // Particle bursts now fire from collectible score effect (at board positions)

      const clearId = window.setTimeout(() => {
        setMainScoreFloating(null);
      }, 2000);

      prevTotalScoreRef.current = currentScore;
      return () => window.clearTimeout(clearId);
    }
  }, [totalScore, myColor]);

  // Coordinate Helper
  const getVisualPos = (absX: number, absY: number, height: number = 0) => {
    const MAX_GRID = 26;
    const center = Math.floor(MAX_GRID / 2);
    const halfWidth = Math.floor(gridWidth / 2);
    const halfHeight = Math.floor(gridHeight / 2);
    const minX = center - halfWidth;
    const minY = center - halfHeight;

    const x = absX - minX;
    const y = absY - minY;

    const offsetX = (gridWidth - 1) / 2;
    const offsetY = (gridHeight - 1) / 2;
    return [
      (x - offsetX) * SPACING,
      height,
      (y - offsetY) * SPACING
    ] as [number, number, number];
  };

  const getDisplayColor = (collectibleColor: string) => {
    if (collectibleColor === "NEUTRAL") return "#ffffff";
    if (collectibleColor === "RED" || collectibleColor === "GREEN" || collectibleColor === "BLUE") {
      return getPlayerHex(collectibleColor);
    }
    const colorLower = COLOR_MAP_LOWER[collectibleColor as PlayerColor];
    if (!colorLower) return getPlayerHex("GREEN");
    return getPlayerHex(colorLower.toUpperCase() as PlayerColor);
  };

  return (
    <div className="isolate w-full h-screen relative overflow-hidden bg-canvas">
      {/* Cloud nebula backdrop is rendered inside the R3F Canvas (NebulaBackdrop). */}
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-gradient-to-t from-canvas/25 via-transparent to-transparent"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_100%_70%_at_50%_45%,transparent_35%,hsl(222_45%_6%/0.35)_100%)]"
        aria-hidden
      />
      {/* NOTE: PolarAmbientParticlesCanvas & NoiseBlobFieldCanvas removed —
           hidden behind opaque R3F Canvas (z-[1]), wasted WebGL contexts.
           NoiseFieldOverlay + ScoreBurstOverlay moved AFTER the R3F Canvas below. */}
      <style>{`
        @keyframes hudVotePulse {
          0%,
          100% {
            filter: brightness(1);
          }
          50% {
            filter: brightness(1.12);
          }
        }
        @keyframes hudVoteBanner {
          0% {
            opacity: 0;
            transform: translate(-50%, -8px);
          }
          18% {
            opacity: 1;
            transform: translate(-50%, 0);
          }
          70% {
            opacity: 1;
            transform: translate(-50%, 0);
          }
          100% {
            opacity: 0;
            transform: translate(-50%, -4px);
          }
        }
        @keyframes scoreGainPop {
          0% {
            transform: translateY(14px) scale(0.45) rotate(-8deg);
            opacity: 0;
          }
          12% {
            transform: translateY(-6px) scale(1.14) rotate(4deg);
            opacity: 1;
          }
          30% {
            transform: translateY(-3px) scale(1.02) rotate(-1deg);
          }
          52% {
            transform: translateY(-5px) scale(1) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(-84px) scale(0.86) rotate(0deg);
            opacity: 0;
          }
        }
        @keyframes scoreLossPop {
          0% {
            transform: translateY(0) scale(1);
            opacity: 1;
          }
          22% {
            transform: translateY(4px) scale(1.12) rotate(-4deg);
          }
          100% {
            transform: translateY(56px) scale(0.75) rotate(6deg);
            opacity: 0;
          }
        }
        @keyframes scoreBurstRing {
          0% {
            transform: translate(-50%, -50%) scale(0.35);
            opacity: 0.65;
          }
          100% {
            transform: translate(-50%, -50%) scale(2.4);
            opacity: 0;
          }
        }
      `}</style>

      {/* HUD: frosted polar chrome (match timer / stage chips); settings swap into same shell */}
      <div className="absolute left-4 top-4 z-20 flex w-[min(11.5rem,calc(100vw-2rem))] flex-col gap-2">
        <div
          className="relative flex flex-col overflow-hidden rounded-none border border-solid bg-canvas/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-[4px]"
          style={{ borderColor: POLAR_HUD.border }}
          role="status"
          aria-live="polite"
          data-ui="game-hud-panel"
        >
          <HudCornerLs />
          <div className="relative z-[1] flex min-h-0 flex-col">
          {settingsOpen && (
            <div className="relative z-30 flex h-9 w-full shrink-0 items-center justify-end border-b border-white/10 bg-canvas/30 px-2">
              <button
                type="button"
                onClick={requestCloseSettings}
                aria-controls="game-settings-panel"
                aria-label="Close settings"
                title="Close"
                className="flex size-7 shrink-0 items-center justify-center rounded-none text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                <X className="size-3.5" strokeWidth={1.65} aria-hidden />
              </button>
            </div>
          )}

          {settingsOpen && (
            <div
              id="game-settings-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="game-settings-title"
              className={cn(
                "relative z-20 flex max-h-[min(70vh,22rem)] min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto bg-transparent px-3 py-3 transition-opacity duration-300 ease-out",
                settingsExiting ? "pointer-events-none opacity-0" : "opacity-100",
              )}
            >
              <p
                id="game-settings-title"
                className="font-montreal text-[9px] font-medium uppercase tracking-[0.12em] text-slate-500"
              >
                Settings
              </p>
              {bgMusicVolume !== undefined && onBgMusicVolumeChange && (
                <div className="w-full min-w-0">
                  <p className="mb-1.5 font-montreal text-[9px] uppercase tracking-[0.12em] text-slate-500">
                    Music
                  </p>
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onBgMusicVolumeChange(bgMusicVolume > 0 ? 0 : 0.3)}
                      className="shrink-0 text-slate-300 transition-colors hover:text-white"
                      aria-label={bgMusicVolume > 0 ? "Mute music" : "Unmute music"}
                    >
                      {bgMusicVolume > 0 ? (
                        <Volume2 className="size-4" aria-hidden />
                      ) : (
                        <VolumeX className="size-4" aria-hidden />
                      )}
                    </button>
                    <PolarSlider
                      value={bgMusicVolume}
                      onChange={onBgMusicVolumeChange}
                      ariaLabel="Music volume"
                    />
                    <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-slate-500">
                      {Math.round(bgMusicVolume * 100)}
                    </span>
                  </div>
                </div>
              )}
              <div className="w-full min-w-0">
                <p className="mb-1.5 font-montreal text-[9px] uppercase tracking-[0.12em] text-slate-500">
                  SFX
                </p>
                <div className="flex w-full min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSfxVolume(sfxVolume > 0 ? 0 : 0.5)}
                    className="shrink-0 text-slate-300 transition-colors hover:text-white"
                    aria-label={sfxVolume > 0 ? "Mute sound effects" : "Unmute sound effects"}
                  >
                    {sfxVolume > 0 ? (
                      <Volume2 className="size-4" aria-hidden />
                    ) : (
                      <VolumeX className="size-4" aria-hidden />
                    )}
                  </button>
                  <PolarSlider
                    value={sfxVolume}
                    onChange={setSfxVolume}
                    ariaLabel="SFX volume"
                  />
                  <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-slate-500">
                    {Math.round(sfxVolume * 100)}
                  </span>
                </div>
              </div>
              {room?.roomId && (
                <div className="border-t border-white/10 pt-3">
                  <p className="font-montreal text-[10px] uppercase tracking-[0.12em] text-slate-500">
                    Room code
                  </p>
                  <p className="mt-1 font-mono text-sm font-semibold tracking-widest text-white">
                    {room.roomId}
                  </p>
                </div>
              )}
            </div>
          )}

          {!settingsOpen && (
            <>
          {isSoloMode ? (
            <>
              <div className="relative z-10 flex w-full shrink-0 flex-col gap-3 px-3 py-3">
                <div className="grid min-w-0 gap-1">
                  <p className="font-montreal text-[9px] uppercase leading-none tracking-[0.12em] text-slate-500">
                    Mode
                  </p>
                  <p className="truncate text-xs font-medium tabular-nums leading-tight text-slate-200">
                    Solo mode
                  </p>
                </div>
                <div className="grid min-w-0 gap-1">
                  <p className="font-montreal text-[9px] uppercase leading-none tracking-[0.12em] text-slate-500">
                    Color
                  </p>
                  <p
                    className="truncate text-xs font-medium tabular-nums leading-tight text-slate-200"
                    style={{
                      color: Array.from(players.values())[activePlayerIndex]
                        ? getPlayerUiLabelHex(Array.from(players.values())[activePlayerIndex].color)
                        : undefined,
                    }}
                  >
                    {Array.from(players.values())[activePlayerIndex]
                      ? getPlayerDisplayLabel(Array.from(players.values())[activePlayerIndex].color)
                      : "…"}
                  </p>
                </div>
              </div>

              <div className="relative z-10 flex min-h-10 w-full shrink-0 flex-nowrap items-center justify-between gap-x-2 border-t border-white/10 px-3 py-2">
                <div className="flex min-w-0 flex-1 items-center gap-x-1.5">
                  <kbd
                    className="inline-flex shrink-0 items-center rounded-none border border-solid bg-canvas/50 px-1.5 py-0.5 font-montreal text-[9px] font-medium uppercase tracking-[0.1em] text-slate-400"
                    style={{ borderColor: POLAR_HUD.border }}
                  >
                    Tab
                  </kbd>
                  <span className="min-w-0 truncate text-[11px] leading-snug text-slate-500">
                    Switch player
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setControlsOpen(v => !v)}
                    aria-expanded={controlsOpen}
                    aria-label="Toggle controls"
                    title="Controls"
                    className="flex size-7 shrink-0 items-center justify-center rounded-none text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  >
                    <Info className="size-3.5" strokeWidth={1.65} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={openSettings}
                    aria-expanded={settingsOpen}
                    aria-controls="game-settings-panel"
                    aria-label="Open settings"
                    title="Settings"
                    className="flex size-7 shrink-0 items-center justify-center rounded-none text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  >
                    <Settings className="size-3.5" strokeWidth={1.65} aria-hidden />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="relative z-10 flex w-full shrink-0 flex-col gap-3 px-3 py-3">
              <div className="grid min-w-0 gap-1">
                <p className="font-montreal text-[9px] uppercase leading-none tracking-[0.12em] text-slate-500">
                  Mode
                </p>
                <p className="truncate text-xs font-medium tabular-nums leading-tight text-slate-200">Multiplayer</p>
              </div>
              {room?.roomId && (
                <div className="grid min-w-0 gap-1">
                  <p className="font-montreal text-[9px] uppercase leading-none tracking-[0.12em] text-slate-500">
                    Room code
                  </p>
                  <p className="truncate font-mono text-xs font-semibold tracking-widest text-white">
                    {room.roomId}
                  </p>
                </div>
              )}
              <div className="grid min-w-0 gap-1">
                <p className="font-montreal text-[9px] uppercase leading-none tracking-[0.12em] text-slate-500">
                  You
                </p>
                <p
                  className="truncate text-xs font-medium tabular-nums leading-tight text-slate-200"
                  style={{ color: myColor ? getPlayerUiLabelHex(myColor) : undefined }}
                >
                  {localPlayerDisplayName ?? (myColor ? getPlayerDisplayLabel(myColor) : "…")}
                </p>
              </div>
              <div className="flex w-full shrink-0 justify-end gap-0.5 border-t border-white/10 pt-2">
                <button
                  type="button"
                  onClick={() => setControlsOpen(v => !v)}
                  aria-expanded={controlsOpen}
                  aria-label="Toggle controls"
                  title="Controls"
                  className="flex size-7 shrink-0 items-center justify-center rounded-none text-slate-500 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <Info className="size-3.5" strokeWidth={1.65} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={openSettings}
                  aria-expanded={settingsOpen}
                  aria-controls="game-settings-panel"
                  aria-label="Open settings"
                  title="Settings"
                  className="flex size-7 shrink-0 items-center justify-center rounded-none text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <Settings className="size-3.5" strokeWidth={1.65} aria-hidden />
                </button>
              </div>
            </div>
          )}
            </>
          )}
          </div>
        </div>

        {/* Controls reference — toggled via info button */}
        {controlsOpen && <GameControls showPing={!isSoloMode} />}
      </div>

      {/* Stage Display - Top Center (polar blue chrome) */}
      <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2">
        {/* Outer glow — intensity scales with stage + bloom pulse on transition */}
        <div
          className="absolute -inset-3 rounded-sm"
          style={{
            background: barBloom > 0
              ? `radial-gradient(ellipse at center, rgba(56,189,248,${0.15 + barBloom * 0.3}) 0%, rgba(186,230,253,${barBloom * 0.1}) 50%, transparent 75%)`
              : `radial-gradient(ellipse at center, rgba(56,189,248,${0.06 + (effectiveStage / 8) * 0.18}) 0%, transparent 70%)`,
            filter: `blur(${barBloom > 0 ? 10 + barBloom * 8 : 6 + effectiveStage * 1.5}px)`,
            transition: barBloom > 0 ? "none" : "all 1.5s ease-out",
          }}
          aria-hidden
        />
        <div
          className="relative min-w-[7rem] rounded-none border border-solid bg-canvas/50 px-5 py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-[4px]"
          style={{
            borderColor: `rgba(56,189,248,${0.2 + (effectiveStage / 8) * 0.2})`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 ${8 + effectiveStage * 3}px rgba(56,189,248,${0.05 + (effectiveStage / 8) * 0.15})`,
          }}
          data-ui="game-stage-chip"
        >
          <HudCornerLs />
          <div className="relative z-[1]">
            {challengeName ? (
              <p className="mb-1.5 font-montreal text-[8px] uppercase leading-tight tracking-[0.12em] text-slate-500">
                {challengeName}
              </p>
            ) : null}
            <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">Stage</p>
            <p className="font-montreal text-3xl font-bold leading-tight tracking-[-0.02em] text-white">{stage}</p>
          </div>
        </div>
      </div>

      {/* Right side: stage target, vertical meter, high score marker, current below bar */}
      <div className="absolute right-4 top-1/2 z-10 max-h-[calc(100vh-2rem)] -translate-y-1/2 sm:right-6">
        <aside
          className="flex w-auto max-w-[min(18rem,calc(100vw-2rem))] flex-col items-end"
          aria-label="Stage target and scores"
          data-ui="game-score-panel"
        >
          <div className="relative pl-[5.5rem] sm:pl-[5.75rem]">
            <div
              className="relative ml-auto rounded-none border border-solid bg-canvas/50 py-2.5 pl-1.5 pr-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-[4px]"
              style={{ borderColor: POLAR_HUD.border }}
              data-ui="game-score-panel-frame"
            >
              <HudCornerLs />
              <div className="relative z-[1] ml-auto w-14">
              <div
                className="mb-2 w-14 border-b border-white/10 pb-2 text-center"
                role="group"
                aria-label={`Stage target ${currentStageThreshold.toFixed(0)}`}
              >
                <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">
                  Stage
                </p>
                <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">
                  Target
                </p>
                <p className="font-montreal text-lg font-bold leading-tight text-white">
                  {currentStageThreshold.toFixed(0)}
                </p>
              </div>

              {/* Floating score change — snap-in, ring burst on gains, drift + fade out */}
              {mainScoreFloating && (
                <div
                  key={mainScoreFloating.id}
                  className="pointer-events-none absolute -top-20 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center"
                >
                  {mainScoreFloating.score > 0 && (
                    <span
                      className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-none border-2 border-white/50 bg-white/15"
                      style={{
                        animation: "scoreBurstRing 0.85s cubic-bezier(0.22, 1, 0.36, 1) forwards",
                      }}
                      aria-hidden
                    />
                  )}
                  <div
                    className="relative whitespace-nowrap font-montreal text-5xl font-extrabold tracking-tight will-change-[transform,opacity] sm:text-6xl"
                    style={{
                      animation: `${mainScoreFloating.score > 0 ? "scoreGainPop" : "scoreLossPop"} 1.75s cubic-bezier(0.25, 0.9, 0.35, 1) forwards`,
                      color: mainScoreFloating.score > 0 ? "#f8fafc" : "#fca5a5",
                    }}
                  >
                    {mainScoreFloating.score > 0 ? "+" : ""}
                    {mainScoreFloating.score}
                  </div>
                </div>
              )}

              {/* Bar shell: overflow-visible wrapper so high score (right-full) is not clipped */}
              <div className="relative flex w-14 justify-center">
                <div className="relative h-[min(22rem,50vh)] w-14 shrink-0 overflow-visible sm:h-[min(24rem,52vh)]">
                  {/* Bloom pulse — flashes on stage change, fades out */}
                  <div
                    className="pointer-events-none absolute -inset-3 z-[-1]"
                    style={{
                      background: `radial-gradient(ellipse at center, rgba(255,255,255,${barBloom * 0.35}) 0%, rgba(255,255,255,${barBloom * 0.12}) 40%, transparent 70%)`,
                      filter: `blur(${12 + barBloom * 8}px)`,
                      opacity: barBloom > 0 ? 1 : 0,
                      transition: barBloom > 0 ? "none" : "opacity 1.5s ease-out",
                    }}
                    aria-hidden
                  />
                  <div
                    className="absolute inset-0 overflow-hidden rounded-none border border-solid bg-white/[0.04] ring-1 ring-inset ring-white/[0.05] backdrop-blur-[4px]"
                    style={{
                      borderColor: barBloom > 0
                        ? `rgba(255,255,255,${0.25 + barBloom * 0.3})`
                        : POLAR_HUD.barBorder,
                      boxShadow: barBloom > 0
                        ? `inset 0 0 20px ${POLAR_HUD.barInset}, 0 0 ${16 + barBloom * 12}px rgba(255,255,255,${barBloom * 0.2})`
                        : `inset 0 0 20px ${POLAR_HUD.barInset}`,
                      transition: barBloom > 0 ? "none" : "border-color 1.5s ease-out, box-shadow 1.5s ease-out",
                    }}
                  >
                    {/* Subtle vertical scanline texture */}
                    <div
                      className="absolute inset-0 opacity-[0.03]"
                      style={{
                        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 3px)",
                      }}
                      aria-hidden
                    />
                    <div className="absolute inset-0 overflow-hidden rounded-none">
                      <div
                        className="absolute bottom-0 left-0 right-0 overflow-hidden transition-[height] duration-500 ease-out"
                        style={{
                          height: `${scoreBarFillPercent}%`,
                        }}
                      >
                        <div
                          className="absolute inset-0"
                          style={{
                            background: scoreBarGradient,
                          }}
                        />
                        {/* Inner shimmer highlight */}
                        <div
                          className="absolute inset-y-0 left-0 w-[40%] opacity-30"
                          style={{
                            background: "linear-gradient(to right, rgba(255,255,255,0.15), transparent)",
                          }}
                          aria-hidden
                        />
                        {/* Bright edge line at fill top (inside overflow) */}
                        <div
                          className="absolute left-0 right-0 top-0 h-3"
                          style={{
                            background: "linear-gradient(to bottom, rgba(255,255,255,0.6), rgba(255,255,255,0.15) 40%, transparent)",
                          }}
                          aria-hidden
                        />
                      </div>
                    </div>
                  </div>

                  {/* Soft glow halo at fill top edge — OUTSIDE overflow:hidden */}
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-[2] h-0 transition-[bottom] duration-500 ease-out"
                    style={{ bottom: `${scoreBarFillPercent}%` }}
                    aria-hidden
                  >
                    <div
                      className="absolute -left-2 -right-2 -top-4 h-8"
                      style={{
                        background: "radial-gradient(ellipse 120% 100% at 50% 50%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 70%)",
                        filter: "blur(4px)",
                      }}
                    />
                  </div>

                  {/* Zero-height anchor at high-score % so -translate-y-1/2 centers on the fill top (not the box middle). */}
                  <div
                    className="absolute right-full top-auto z-10 h-0 w-[5.5rem] overflow-visible transition-[bottom] duration-500 ease-out sm:w-[5.75rem]"
                    style={{ bottom: `${highScoreBarPercent}%` }}
                  >
                    <div className="flex w-full -translate-y-1/2 items-center justify-end gap-0 pr-2 sm:pr-2.5">
                      <div
                        className="min-w-0 text-right"
                        role="group"
                        aria-label={`High score ${highScore.toFixed(0)}`}
                      >
                        <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">
                          High score
                        </p>
                        <p className="font-montreal text-lg font-bold tabular-nums leading-tight text-white">
                          {highScore.toFixed(0)}
                        </p>
                      </div>
                      <div
                        className="ml-1.5 flex w-10 shrink-0 items-center sm:ml-2 sm:w-12"
                        aria-hidden
                      >
                        <div
                          className="h-[2px] min-w-0 flex-1"
                          style={{
                            background: `linear-gradient(to right, ${POLAR_HUD.connectorFrom}, ${POLAR_HUD.connectorVia}, ${POLAR_HUD.connectorTo})`,
                          }}
                        />
                        <div
                          className="size-1.5 shrink-0 border border-solid"
                          style={{
                            backgroundColor: POLAR_HUD.marker,
                            borderColor: POLAR_HUD.markerRing,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div
                className="mt-2 w-14 border-t border-white/10 pt-2 text-center"
                role="group"
                aria-label={`Current score ${totalScore.toFixed(0)}`}
              >
                <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">
                  Current
                </p>
                <p className="font-montreal text-lg font-bold tabular-nums leading-tight text-white">
                  {totalScore.toFixed(0)}
                </p>
              </div>
            </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Clear-board vote banner — top center, fades quickly */}
      {!isSoloMode && clearBoardBannerVisible && clearBoardInitiatorColor && (
        <div
          key={clearBoardExpiresAt ?? "clear-banner"}
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-28 z-20 whitespace-nowrap rounded-none border border-solid bg-canvas/65 px-5 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-inset ring-white/[0.08] backdrop-blur-[6px]"
          style={{
            borderColor: POLAR_HUD.border,
            animation: "hudVoteBanner 2.2s ease-out forwards",
          }}
        >
          <HudCornerLs />
          <p className="relative z-[1] font-montreal text-[13px] font-semibold uppercase leading-tight tracking-[0.16em] text-white">
            <span style={{ color: getPlayerUiLabelHex(clearBoardInitiatorColor) }}>
              {clearBoardInitiatorName ?? getPlayerDisplayLabel(clearBoardInitiatorColor)}
            </span>
            <span className="font-normal text-slate-200"> wants to clear board</span>
          </p>
        </div>
      )}

      {/* Abandon-game vote banner — top center, fades quickly (red) */}
      {!isSoloMode && abandonBannerVisible && abandonInitiatorColor && (
        <div
          key={abandonExpiresAt ?? "abandon-banner"}
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-28 z-20 whitespace-nowrap rounded-none border border-solid px-5 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-inset backdrop-blur-[6px]"
          style={{
            borderColor: "rgba(248, 113, 113, 0.55)",
            backgroundColor: "rgba(60, 12, 18, 0.7)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 0 18px rgba(248,113,113,0.18)",
            // @ts-expect-error CSS custom property
            "--tw-ring-color": "rgba(248,113,113,0.18)",
            animation: "hudVoteBanner 2.2s ease-out forwards",
          }}
        >
          <HudCornerLs />
          <p className="relative z-[1] font-montreal text-[13px] font-semibold uppercase leading-tight tracking-[0.16em] text-white">
            <span style={{ color: getPlayerUiLabelHex(abandonInitiatorColor) }}>
              {abandonInitiatorName ?? getPlayerDisplayLabel(abandonInitiatorColor)}
            </span>
            <span className="font-normal text-red-100"> wants to abandon game</span>
          </p>
        </div>
      )}

      {/* Timer Display - Bottom Center (polar blue chrome) */}
      <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
        <div
          className="relative min-w-[7.25rem] whitespace-nowrap rounded-none border border-solid bg-canvas/50 px-4 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-[4px]"
          style={{ borderColor: POLAR_HUD.border }}
          data-ui="game-timer-chip"
        >
          <HudCornerLs />
          <div className="relative z-[1]">
            <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">Time</p>
            <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.12em] text-slate-300">Remaining</p>
            <p className="mt-1 font-montreal text-3xl font-bold leading-none tracking-[-0.04em] text-white">
              {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, "0")}
            </p>
          </div>
        </div>
      </div>

      {/* Clear Board Button - Bottom Left */}
      {!isSpectator && !isGameOver && (
        <div className="absolute bottom-4 left-4 z-10">
          <div className="relative flex flex-col items-stretch gap-1.5">
            {!isSoloMode && !clearBoardVoteActive && clearBoardExpiredVisible && (
              <div
                role="status"
                aria-live="polite"
                className="absolute bottom-full left-0 z-10 mb-2 w-[17rem] rounded-none border border-solid bg-canvas/55 px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[6px] ring-1 ring-inset ring-white/[0.06]"
                style={{ borderColor: POLAR_HUD.border }}
              >
                <HudCornerLs />
                <div className="relative z-[1]">
                  <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.14em] text-slate-400">
                    Clear board vote
                  </p>
                  <p className="mt-1 font-montreal text-[12px] font-medium leading-snug text-slate-300">
                    Expired — not enough votes
                  </p>
                </div>
              </div>
            )}
            {!isSoloMode && clearBoardVoteActive && clearBoardInitiatorColor && (
              <div
                role="status"
                aria-live="polite"
                className="absolute bottom-full left-0 z-10 mb-2 w-[17rem] rounded-none border border-solid bg-canvas/55 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[6px] ring-1 ring-inset ring-white/[0.06]"
                style={{
                  borderColor: POLAR_HUD.border,
                  animation: "hudVotePulse 1.6s ease-in-out infinite",
                }}
              >
                <HudCornerLs />
                <div className="relative z-[1]">
                  <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.14em] text-slate-400">
                    Clear board vote
                  </p>
                  <p className="mt-1.5 font-montreal text-[13px] font-semibold leading-snug text-white">
                    <span style={{ color: getPlayerUiLabelHex(clearBoardInitiatorColor) }}>
                      {clearBoardInitiatorName ?? getPlayerDisplayLabel(clearBoardInitiatorColor)}
                    </span>
                    <span className="font-normal text-slate-300"> wants to clear the board</span>
                  </p>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <p className="font-montreal text-[10px] uppercase leading-tight tracking-[0.14em] text-slate-400">
                      {clearBoardVoteCount}/3 votes
                    </p>
                    <p className="font-montreal text-2xl font-bold tabular-nums leading-none tracking-[-0.03em] text-white">
                      {clearBoardSecondsLeft}s
                    </p>
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-stretch gap-2">
          <button
            type="button"
            onClick={() => {
              if (room && !hasVotedClearBoard) {
                room.send("clearBoard", {});
                if (!isSoloMode) {
                  setHasVotedClearBoard(true);
                }
              }
            }}
            disabled={hasVotedClearBoard && !isSoloMode}
            aria-label={
              isSoloMode
                ? "Clear the board"
                : clearBoardVoteActive
                  ? `Clear board vote, ${clearBoardVoteCount} of 3`
                  : hasVotedClearBoard
                    ? "Clear board vote submitted"
                    : "Vote to clear the board"
            }
            data-ui="game-action-clear"
            className={`relative flex min-h-9 min-w-[6.25rem] flex-col items-center justify-center rounded-none border border-solid bg-canvas/40 px-2.5 py-1.5 text-center text-white backdrop-blur-[4px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/35 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:pointer-events-none ${
              clearBoardVoteActive ? "" : "hover:bg-canvas/55"
            }`}
            style={
              clearBoardVoteActive
                ? {
                    backgroundColor: "rgba(15, 23, 42, 0.52)",
                    borderColor: POLAR_HUD.border,
                    borderRadius: 0,
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                    backdropFilter: "blur(4px)",
                    WebkitBackdropFilter: "blur(4px)",
                    animation: "hudVotePulse 1.2s ease-in-out infinite",
                  }
                : {
                    borderColor: POLAR_HUD.border,
                    opacity: hasVotedClearBoard && !isSoloMode ? 0.45 : 1,
                  }
            }
          >
            <HudCornerLs />
            <p className="relative z-[1] font-montreal text-[9px] font-semibold uppercase tracking-[0.14em] leading-tight text-white">
              {isSoloMode
                ? "Clear board"
                : clearBoardVoteActive
                  ? `${clearBoardVoteCount}/3 votes`
                  : hasVotedClearBoard
                    ? "Voted"
                    : "Clear board"}
            </p>
            {!isSoloMode && clearBoardVoteActive && (
              <p className="relative z-[1] mt-0.5 font-montreal text-[8px] uppercase tracking-wider text-slate-500">
                Tap to vote
              </p>
            )}
          </button>

          {!isSoloMode && !abandonVoteActive && abandonExpiredVisible && (
            <div
              role="status"
              aria-live="polite"
              className="absolute bottom-full left-0 z-10 mb-2 w-[17rem] rounded-none border border-solid px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[6px] ring-1 ring-inset"
              style={{
                borderColor: "rgba(248, 113, 113, 0.5)",
                backgroundColor: "rgba(60, 12, 18, 0.55)",
                // @ts-expect-error CSS custom property
                "--tw-ring-color": "rgba(248,113,113,0.15)",
              }}
            >
              <HudCornerLs />
              <div className="relative z-[1]">
                <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.14em] text-red-200/80">
                  Abandon game vote
                </p>
                <p className="mt-1 font-montreal text-[12px] font-medium leading-snug text-red-100">
                  Expired — not enough votes
                </p>
              </div>
            </div>
          )}
          {!isSoloMode && abandonVoteActive && abandonInitiatorColor && (
            <div
              role="status"
              aria-live="polite"
              className="absolute bottom-full left-0 z-10 mb-2 w-[17rem] rounded-none border border-solid bg-canvas/55 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[6px] ring-1 ring-inset ring-white/[0.06]"
              style={{
                borderColor: POLAR_HUD.border,
                animation: "hudVotePulse 1.6s ease-in-out infinite",
              }}
            >
              <HudCornerLs />
              <div className="relative z-[1]">
                <p className="font-montreal text-[9px] uppercase leading-tight tracking-[0.14em] text-slate-400">
                  Abandon game vote
                </p>
                <p className="mt-1.5 font-montreal text-[13px] font-semibold leading-snug text-white">
                  <span style={{ color: getPlayerUiLabelHex(abandonInitiatorColor) }}>
                    {abandonInitiatorName ?? getPlayerDisplayLabel(abandonInitiatorColor)}
                  </span>
                  <span className="font-normal text-slate-300"> wants to abandon the game</span>
                </p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <p className="font-montreal text-[10px] uppercase leading-tight tracking-[0.14em] text-slate-400">
                    {abandonVoteCount} voted
                  </p>
                  <p className="font-montreal text-2xl font-bold tabular-nums leading-none tracking-[-0.03em] text-white">
                    {abandonSecondsLeft}s
                  </p>
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (room && !hasVotedAbandon) {
                room.send("abandonGame", {});
                if (isSoloMode) {
                  playSound("abandon");
                  onGameAbandonedRef.current?.();
                } else {
                  setHasVotedAbandon(true);
                }
              }
            }}
            disabled={hasVotedAbandon && !isSoloMode}
            aria-label={
              isSoloMode
                ? "Abandon game and exit"
                : abandonVoteActive
                  ? `Abandon vote, ${abandonVoteCount} players voted`
                  : hasVotedAbandon
                    ? "Abandon vote submitted"
                    : "Vote to abandon the match"
            }
            data-ui="game-action-abandon"
            className={`relative flex min-h-9 min-w-[6.25rem] flex-col items-center justify-center rounded-none border border-solid bg-canvas/40 px-2.5 py-1.5 text-center text-white backdrop-blur-[4px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/35 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:pointer-events-none ${
              abandonVoteActive ? "" : "hover:bg-canvas/55"
            }`}
            style={
              abandonVoteActive
                ? {
                    backgroundColor: "rgba(15, 23, 42, 0.52)",
                    borderColor: POLAR_HUD.border,
                    borderRadius: 0,
                    boxShadow: `inset 0 0 0 1px ${POLAR_HUD.border}`,
                    backdropFilter: "blur(4px)",
                    WebkitBackdropFilter: "blur(4px)",
                    animation: "hudVotePulse 1.2s ease-in-out infinite",
                  }
                : {
                    borderColor: POLAR_HUD.border,
                    opacity: hasVotedAbandon && !isSoloMode ? 0.45 : 1,
                  }
            }
          >
            <HudCornerLs />
            <p className="relative z-[1] font-montreal text-[9px] font-semibold uppercase tracking-[0.14em] leading-tight text-white">
              {isSoloMode
                ? "Abandon game"
                : abandonVoteActive
                  ? `${abandonVoteCount} voted`
                  : hasVotedAbandon
                    ? "Voted"
                    : "Abandon game"}
            </p>
            {!isSoloMode && abandonVoteActive && (
              <p className="relative z-[1] mt-0.5 font-montreal text-[8px] uppercase tracking-wider text-slate-500">
                Tap to vote
              </p>
            )}
          </button>
            </div>
          </div>
        </div>
      )}

      {/* Spectator Badge */}
      {isSpectator && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-none border border-hairline/40 bg-canvas/45 px-4 py-2 font-montreal text-[11px] uppercase tracking-wider text-slate-400 backdrop-blur-[6px]">
          Spectating
        </div>
      )}

      {/* Dev Mode Panel - Bottom Right */}
      {isDevMode && (
        <div className="absolute bottom-8 right-8 z-10 flex flex-col items-end gap-2">
          <div className="rounded-none border border-yellow-500/25 bg-canvas/45 px-3 py-1.5 backdrop-blur-[6px]">
            <p className="text-xs font-mono text-yellow-300/80">Seed: {seed}</p>
          </div>
          <button
            onClick={() => {
              if (room) {
                console.log(`[Dev Mode] Score at stage up: ${totalScore} (RED: ${scores.RED}, GREEN: ${scores.GREEN}, BLUE: ${scores.BLUE}) | Stage: ${stage}`);
                room.send("devStageUp", {});
              }
            }}
            className="rounded-none border border-yellow-500/35 bg-yellow-950/50 px-4 py-2 font-montreal text-xs uppercase tracking-wider backdrop-blur-[6px] transition-colors hover:border-yellow-400/50 hover:bg-yellow-950/70"
          >
            <p className="text-sm font-bold text-yellow-300">Stage Up</p>
            <p className="text-xs text-yellow-300/60 mt-0.5">Dev Mode</p>
          </button>
        </div>
      )}


      {/* Main Game Canvas */}
      <CanvasErrorBoundary>
      <Canvas
        className="absolute inset-0 z-[1] h-full w-full min-h-0"
        style={{ background: "#000000" }}
        gl={{
          powerPreference: "default",
          failIfMajorPerformanceCaveat: false,
        }}
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          canvas.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            console.warn("[WebGL] Context lost");
          });
          canvas.addEventListener("webglcontextrestored", () => {
            console.log("[WebGL] Context restored");
          });
        }}
      >
        <NebulaBackdrop />

        <OrthographicCamera
          makeDefault
          position={get2DCameraPosition(gridWidth, gridHeight)}
          rotation={[-Math.PI / 2, 0, 0]}
          zoom={calcBoardZoom(gridWidth, gridHeight, SPACING, window.innerHeight)}
        />

        <SmoothZoom
          gridWidth={gridWidth}
          gridHeight={gridHeight}
          spacing={SPACING}
        />

        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow />
        <pointLight position={[-10, -10, -10]} intensity={0.5} color={getFloorTint("GREEN")} />

        <ParticleFloor key={`floor-${gridWidth}-${gridHeight}`} gridWidth={gridWidth} gridHeight={gridHeight} spacing={SPACING} nodeStates={nodeStates} rippleTrigger={rippleTrigger} />
            <ConnectionLines key={`lines-${gridWidth}-${gridHeight}`} nodeStates={nodeStates} gridWidth={gridWidth} gridHeight={gridHeight} />

            {/* Collectibles */}
            {/* EDIT COLLECTIBLE SHAPES HERE!!!!!! */}
            {collectibles.map((collectible) => {
              const pos = getVisualPos(collectible.x, collectible.y, -2.0);
              const displayColor = getDisplayColor(collectible.color);

              if (collectible.type === "network") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <SpinningLambda color={displayColor} connected={collectible.isActivated} />
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "box") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <group rotation={[0, Math.PI / 8, 0]}>
                        <CubeFrame color={displayColor} scale={0.75} connected={collectible.isActivated} />
                      </group>
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "equilibrium") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <group rotation={[Math.PI / 2, 0, 0]}>
                        <EquilateralTriangle color={displayColor} scale={1.0} connected={collectible.isActivated} />
                      </group>
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "clone") {
                const rotationY = Math.PI + (collectible.orientation * Math.PI) / 180;
                const flipScale = collectible.isFlipped ? -1 : 1;
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <group rotation={[0, rotationY, 0]} scale={[flipScale, 1, 1]}>
                        <Hand color={displayColor} scale={0.6} connected={collectible.isActivated} />
                      </group>
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "vantage") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <group rotation={[Math.PI / 2, 0, 0]} scale={0.5}>
                        <Compass color={displayColor} scale={1.0} connected={collectible.isActivated} />
                      </group>
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "galaxy") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <group rotation={[Math.PI / 2, 0, 0]}>
                        <GalaxyModel color={displayColor} scale={0.72} connected={collectible.isActivated} />
                      </group>
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "polyomino") {
                return (
                  <group key={collectible.id} position={pos}>
                    <GoldAura isGold={collectible.isGold} color={displayColor}>
                      <Polyomino color={displayColor} playerColor={collectible.color} scale={1.0} connected={collectible.isActivated} />
                    </GoldAura>
                  </group>
                );
              } else if (collectible.type === "checkpoint") {
                  console.log("collectible: " + collectible.num);
                  if (collectible.num == 1) { //shape for first
                    return (
                      <group key={collectible.id} position={pos}>
                        <GoldAura isGold={collectible.isGold} color={collectible.color}>
                          <Flower01 color={displayColor} scale={1.0} connected={collectible.isActivated} />
                        </GoldAura>
                      </group>
                    )
                  }
                  else {
                    return (
                    <group key={collectible.id} position={pos}>
                        <GoldAura isGold={collectible.isGold} color={collectible.color}>
                          <FlowerBase color={displayColor} scale={1.0} connected={collectible.isActivated} />
                        </GoldAura>
                      </group>
                    )
                  }
                // repeat for each number
              }



              return null;
            })}

            {/* Floating Score Animations */}
            {floatingScores.map((fs) => (
              <FloatingScore
                key={fs.id}
                position={fs.position}
                score={fs.score}
                timestamp={fs.timestamp}
                onComplete={() => {
                  setFloatingScores(prev => prev.filter(s => s.id !== fs.id));
                }}
              />
            ))}

            {/* Players */}
            {Array.from(players.values()).map((player, index) => {
              const isMe = isSoloMode ? index === activePlayerIndex : player.color === myColor;
              // Use predicted position for local player in multiplayer
              const playerX = isMe && predictedPos ? predictedPos.x : player.x;
              const playerY = isMe && predictedPos ? predictedPos.y : player.y;
              const pos = getVisualPos(playerX, playerY, -1.5);
              return (
                <Player
                  key={player.sessionId || index}
                  color={COLOR_MAP_LOWER[player.color]}
                  position={pos}
                  rotation={0}
                  isMe={isMe}
                />
              );
            })}

            {/* Enemies */}
            {enemies.map((enemy) => {
              const pos = getVisualPos(enemy.x, enemy.y, -2.0);
              return (
                <EnemyEntity key={enemy.id} position={pos} personality={enemy.personality as "red-avoiding" | "green-avoiding" | "blue-avoiding" | "same-color-avoiding" | "prismatic"} />
              );
            })}

            {/* Ping Effects */}
            {pings.map((ping) => {
              const pos: [number, number, number] = [ping.x, -2.4, ping.y];
              const pingColor = PLAYER_HEX[ping.color];
              return (
                <PulseRipple
                  key={ping.id}
                  position={pos}
                  color={pingColor}
                  duration={1.1}
                  maxRadius={2.4}
                  onComplete={() => {
                    setPings((prev) => prev.filter((p) => p.id !== ping.id));
                  }}
                />
              );
            })}

            {!isSpectator && !isGameOver && (
              <ClickHandler
                spacing={SPACING}
                gridWidth={gridWidth}
                gridHeight={gridHeight}
                isDevMode={isDevMode}
                onPing={(x, y) => {
                  if (room) {
                    room.send("ping", { x, y });
                  }
                }}
                onDevNodeClick={(gridX, gridY) => {
                  // Determine the active player's color (same logic as movement)
                  const playerArray = Array.from(players.values());
                  const currentPlayer = isSoloMode
                    ? playerArray[activePlayerIndex]
                    : playerArray.find(p => p.color === myColor);

                  const activeColor = currentPlayer?.color;

                  if (room && activeColor) {
                    // Client-side prediction: show color immediately
                    const key = `${gridX},${gridY}`;
                    setPredictedGridColors(prev => new Map(prev).set(key, activeColor));
                    room.send("devPaintNode", { x: gridX, y: gridY, color: activeColor });
                  }
                }}
                onDevNodeRightClick={(gridX, gridY) => {
                  if (room) {
                    // Client-side prediction: clear color immediately
                    const key = `${gridX},${gridY}`;
                    setPredictedGridColors(prev => new Map(prev).set(key, "clear"));
                    room.send("devClearNode", { x: gridX, y: gridY });
                  }
                }}
              />
            )}

        <DeferredEffects />

      </Canvas>
      </CanvasErrorBoundary>

      {/* Overlays — AFTER R3F Canvas, no wrapper divs, canvases use mix-blend-mode:screen */}
      <NoiseFieldOverlay ref={noiseFieldRef} resolutionScale={0.8} />
      <StageAnnouncement stage={effectiveStage} />
      <DevStageControls room={room} isDevMode={isDevMode} stage={effectiveStage} onFakeStageChange={setFakeStage} />

    </div>
  );
};
