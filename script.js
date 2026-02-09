// Game Configuration

const Config = {
    Visual: {
        ZOOM: 0.6,
        SUBSTEPS: 8,
        FRICTION: 0.998,
        TILT_SENSITIVITY: 1.5,
        BG_BLUR: 'blur(1px) brightness(1.2) saturate(120%)',
        BG_SCALE_RES: 0.15,
        GLUE_THICKNESS: 4,
    },

    Ratios: {
        GRAVITY: 0.00060,
        JUMP_FORCE_MULT: 0.0007,
        MAX_JUMP_FORCE: 0.15,
        TIDE_SPEED: 0.001,
        TIDE_CATCHUP: 0.005,
        WALL_GAP_MIN: 0.2,
        WALL_GAP_RANGE: 0.4,
        WALL_HEIGHT: 0.05,
        WALL_WIDTH_MIN: 0.10,
        WALL_WIDTH_RANGE: 0.5,
        PLAYER_RADIUS: 0.025,
        INDICATOR_LENGTH: 0.15,
        TIDE_WAVE_AMP: 0.015,
        TIDE_GLITCH_SPIKE: 0.03,
        TIDE_LINE_WIDTH: 0.003,
        TIDE_START_OFFSET: 0.4,
        TIDE_COLLISION_THRESHOLD: 0.03,
        CAMERA_LIMIT_PADDING: 0.1,
        GEN_TRIGGER_DIST: 1.2,
        CLEANUP_DIST: 1.0,
        STICKY_DRAG: 1.5,
        STICKY_RELEASE_FORCE: 0.5
    },

    Colors: {
        PLAYER: '#00ff88',
        TIDE_BASE: '#ff0055',
        TIDE_STROKE: '#ff99aa',
        TIDE_SHADOW: '#ff3366',
        WALL_NORMAL: { fill: 'rgba(0, 255, 255, 0.1)', stroke: '#00ccff', shadow: '#00ccff' },
        WALL_BOUNCY: { fill: 'rgba(255, 0, 255, 0.2)', stroke: '#ff00ff', shadow: '#ff00ff' },
        WALL_VERTICAL: { fill: 'rgba(255, 255, 0, 0.1)', stroke: '#ffff00', shadow: '#ffff00' }
    }
};

// --- Core Utilities ---

/**
 * Manages Event interactions between components.
 * Simple Pub/Sub pattern.
 */
class EventEmitter {
    constructor() {
        this.events = {};
    }

    /**
     * Subscribe to an event.
     * @param {string} event - Event name
     * @param {Function} listener - Callback function
     */
    on(event, listener) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(listener);
    }

    /**
     * Emit an event.
     * @param {string} event - Event name
     * @param {any} data - Data to pass to listeners
     */
    emit(event, data) {
        if (this.events[event]) {
            this.events[event].forEach(l => l(data));
        }
    }
}

/**
 * Handles WebRTC connections via PeerJS.
 * Distinguishes between Host and Controller roles.
 */
class NetworkManager extends EventEmitter {
    constructor() {
        super();
        this.peer = null;
        this.conn = null;
        this.isHost = false;
    }

    /**
     * Initialize as Host.
     * Generates a QR code and listens for connections.
     * @param {HTMLElement} qrElement - Element to render QR code into
     * @param {HTMLElement} statusElement - Element to show status text
     */
    initHost(qrElement, statusElement) {
        this.isHost = true;
        this.peer = new Peer();

        this.peer.on('open', (id) => {
            console.log('Host Peer ID:', id);
            const url = `${window.location.href.split('?')[0]}?host=${id}`;
            new QRCode(qrElement, { text: url, width: 180, height: 180 });
            statusElement.textContent = "Scan with phone to start";
        });

        this.peer.on('connection', (c) => {
            this.conn = c;
            statusElement.textContent = "Controller Connected!";
            this.setupDataListener();
            this.emit('connected');

            // Wait a bit before fully starting to let UI transition
            setTimeout(() => this.emit('readyToStart'), 1000);
        });
    }

    /**
     * Initialize as Controller.
     * Connects to the host ID found in URL.
     * @param {string} hostId 
     */
    initController(hostId) {
        this.isHost = false;
        this.peer = new Peer();

        this.peer.on('open', (id) => {
            this.conn = this.peer.connect(hostId);
            this.conn.on('open', () => {
                console.log('Connected to Host');
                this.emit('connected');
            });

            this.conn.on('data', (data) => {
                this.emit('data', data);
            });
        });
    }

    setupDataListener() {
        if (!this.conn) return;
        this.conn.on('data', (data) => {
            if (data.type === 'tilt') this.emit('input_tilt', data.vector);
            if (data.type === 'jump') this.emit('input_jump');
        });
    }

    /**
     * Send data to the connected peer.
     * @param {object} data 
     */
    send(data) {
        if (this.conn && this.conn.open) {
            this.conn.send(data);
        }
    }
}

class InputManager {
    constructor(networkManager) {
        this.tiltVector = { x: 0, y: 0, magnitude: 0, angle: 0 };
        this.networkManager = networkManager;
        this.setupNetworkListeners();
    }

    setupNetworkListeners() {
        this.networkManager.on('input_tilt', (v) => this.tiltVector = v);
        this.networkManager.on('input_jump', () => this.triggerJump());
    }
    onJump(callback) {
        this.jumpCallback = callback;
    }

    triggerJump() {
        if (this.jumpCallback) this.jumpCallback();
    }


}

// --- Entities ---

class PhysicsEntity {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
    }
}

/**
 * The Slime Player.
 * Handles physics, states, and collision response.
 */
class Player extends PhysicsEntity {
    constructor(x, y, radius) {
        super(x, y);
        this.radius = radius;
        this.state = 'stuck';
        this.stickPoint = { x: 0, y: 0 }; // Anchor point for sticky state
        this.impactSpeed = 0; // Stored impact speed for elastic effect
        this.color = Config.Colors.PLAYER;
    }

    resize(ratio) {
        this.x *= ratio;
        this.y *= ratio;
        this.vx *= ratio;
        this.vy *= ratio;
        if (this.stickPoint) {
            this.stickPoint.x *= ratio;
            this.stickPoint.y *= ratio;
        }
    }

    updatePhysics(dt, gravity, friction) {
        if (this.state === 'air') {
            this.vy += gravity * dt;
            this.vx *= Math.pow(friction, dt);
        } else if (this.state === 'sticky') {
            let drag = Config.Ratios.STICKY_DRAG + (this.impactSpeed * 0.005);
            drag = Math.min(0.98, Math.max(0.85, drag));

            const dist = Math.abs(this.y - this.stickPoint.y);
            const tension = dist * 0.002;
            drag -= tension;

            this.vy += gravity * 0.1 * dt;
            this.vy *= Math.pow(Math.max(0.5, drag), dt);

            this.vx *= 0.8;
        }
    }

    jump(angle, forceMagnitude, maxForce, forceMult) {
        if (this.state !== 'stuck' && this.state !== 'sticky') return false;

        const force = Math.min(forceMagnitude * forceMult, maxForce);
        const jumpAngle = angle + Math.PI;

        this.vx = Math.cos(jumpAngle) * force;
        this.vy = Math.sin(jumpAngle) * force;
        this.state = 'air';
        return true;
    }

    checkBounds(width) {
        if (this.x - this.radius < 0) {
            this.x = this.radius;
            this.vx *= -0.7;
        } else if (this.x + this.radius > width) {
            this.x = width - this.radius;
            this.vx *= -0.7;
        }
    }
}

class Wall {
    constructor(x, y, w, h, type = 'normal') {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.type = type;
    }

    checkCollision(p) {
        const closestX = Math.max(this.x, Math.min(p.x, this.x + this.w));
        const closestY = Math.max(this.y, Math.min(p.y, this.y + this.h));

        const dx = p.x - closestX;
        const dy = p.y - closestY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < p.radius) {
            return { dist, dx, dy };
        }
        return null;
    }

    resolve(p, colData) {
        // Depenetrate
        const overlap = p.radius - colData.dist;
        let nx, ny;
        if (colData.dist === 0) {
            nx = 0; ny = -1;
        } else {
            nx = colData.dx / colData.dist; // normalized x component of vector from wall to player
            ny = colData.dy / colData.dist; // normalized y component of vector from wall to player
        }

        p.x += nx * overlap;
        p.y += ny * overlap;

        if (this.type === 'bouncy') {
            const dot = p.vx * nx + p.vy * ny;
            p.vx = p.vx - 2 * dot * nx;
            p.vy = p.vy - 2 * dot * ny;
            p.vx *= 1.1;
            p.vy *= 1.1;
            return false;
        } else {
            // Stick
            // Check for ceiling collision (ny > 0.5 means hit from below)
            if (ny > 0.5 && this.type === 'normal') {
                p.state = 'sticky';
                p.stickPoint = { x: p.x, y: this.y + this.h };
                p.impactSpeed = Math.abs(p.vy);
                p.vx = 0;
                p.vy = 0;
            } else {
                p.state = 'stuck';
                p.vx = 0;
                p.vy = 0;
            }
            return true;
        }
    }
}

class Tide {
    constructor(y) {
        this.y = y;
        this.speed = 0;
        this.waveOffset = 0;
        this.color = Config.Colors.TIDE_BASE;
    }

    update(dt, playerY, worldWidth, worldHeight) {
        // Catch-up Mechanic
        const distToTide = this.y - playerY;
        const catchUpThreshold = worldHeight * 0.5;

        let currentSpeed = this.speed;

        if (distToTide > catchUpThreshold) {
            currentSpeed += (distToTide - catchUpThreshold) * Config.Ratios.TIDE_CATCHUP;
        }

        this.y -= currentSpeed * dt;
        this.waveOffset += 0.1 * dt;
    }
}

class Camera {
    constructor() {
        this.y = 0;
        this.smoothness = 0.1;
    }

    update(targetY, dt, limitY) {
        const lerpFactor = 1 - Math.pow(1 - this.smoothness, dt);
        this.y += (targetY - this.y) * lerpFactor;

        // Clamp to prevent looking into void below tide
        if (this.y > limitY) this.y = limitY;
    }
}

class LevelGenerator {
    constructor() {
        this.highestY = 0;
    }

    reset(startY) {
        this.highestY = startY;
    }

    generateNext(worldWidth) {
        const gap = worldWidth * Config.Ratios.WALL_GAP_MIN + Math.random() * worldWidth * Config.Ratios.WALL_GAP_RANGE;
        const y = this.highestY - gap;

        // Roll Type randomly
        const roll = Math.random();
        let type = 'normal';
        if (roll > 0.73) type = 'bouncy';
        if (roll > 0.78) type = 'vertical';

        let w, h, x;

        if (type === 'vertical') {
            w = worldWidth * Config.Ratios.WALL_HEIGHT;
            h = worldWidth * 0.10 + Math.random() * worldWidth * 0.5;
            x = Math.random() * (worldWidth - w);
        } else {
            w = worldWidth * Config.Ratios.WALL_WIDTH_MIN + Math.random() * worldWidth * Config.Ratios.WALL_WIDTH_RANGE;
            h = worldWidth * Config.Ratios.WALL_HEIGHT;
            x = Math.random() * (worldWidth - w);
        }

        this.highestY = y;
        return new Wall(x, y, w, h, type);
    }
}

// --- Rendering ---

class Renderer {
    constructor(canvas, bgCanvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.bgCanvas = bgCanvas;
        this.bgCtx = bgCanvas.getContext('2d', { alpha: false });
        this.bgCtx.filter = Config.Visual.BG_BLUR;
        this.bgCanvas.style.filter = 'none';
    }

    clear() {
        this.ctx.fillStyle = '#0a0a12';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.bgCanvas.width > 0) {
            this.bgCtx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
        }
    }

    draw(game) {
        this.clear();

        this.drawWorld(this.ctx, game, false);

        // Draw Background
        if (this.bgCanvas.width > 0) {
            this.bgCtx.save();
            const scale = Math.max(
                this.bgCanvas.width / this.canvas.width,
                this.bgCanvas.height / this.canvas.height
            );
            const offsetX = (this.bgCanvas.width - (this.canvas.width * scale)) / 2;
            const offsetY = (this.bgCanvas.height - (this.canvas.height * scale)) / 2;

            this.bgCtx.translate(offsetX, offsetY);
            this.bgCtx.scale(scale, scale);

            this.drawWorld(this.bgCtx, game, true);
            this.bgCtx.restore();
        }

        this.updateDangerUI(game);
    }

    drawWorld(ctx, game, isBackground) {
        ctx.save();
        ctx.scale(Config.Visual.ZOOM, Config.Visual.ZOOM);
        ctx.translate(0, -game.camera.y);

        this.drawWalls(ctx, game.walls, isBackground);

        this.drawPlayer(ctx, game.player, isBackground);

        if (game.player.state === 'stuck' || game.player.state === 'sticky') {
            this.drawAim(ctx, game.player, game.input.tiltVector, game.worldWidth);
        }

        if (game.player.state === 'sticky') {
            this.drawGlue(ctx, game.player);
        }

        this.drawTide(ctx, game.tide, game.worldWidth, isBackground);

        ctx.restore();
    }

    drawWalls(ctx, walls, isBackground) {
        const types = ['normal', 'bouncy', 'vertical'];
        const configs = {
            'normal': Config.Colors.WALL_NORMAL,
            'bouncy': Config.Colors.WALL_BOUNCY,
            'vertical': Config.Colors.WALL_VERTICAL
        };

        types.forEach(type => {
            const batch = walls.filter(w => w.type === type);
            if (batch.length === 0) return;

            const conf = configs[type];

            if (isBackground) {
                ctx.save();
                ctx.beginPath();
                batch.forEach(w => ctx.roundRect(Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h), 5));
                ctx.strokeStyle = conf.shadow;
                ctx.lineWidth = 12;
                ctx.globalAlpha = 0.3;
                ctx.stroke();
                ctx.restore();

                ctx.beginPath();
                batch.forEach(w => ctx.roundRect(Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h), 5));
                ctx.fillStyle = conf.fill;
                ctx.strokeStyle = conf.stroke;
                ctx.lineWidth = 2;
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.fillStyle = conf.fill;
                ctx.strokeStyle = conf.stroke;
                ctx.shadowColor = conf.shadow;
                ctx.shadowBlur = 10;
                ctx.lineWidth = 2;

                ctx.beginPath();
                batch.forEach(w => ctx.roundRect(Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h), 5));
                ctx.fill();
                ctx.stroke();
            }
        });
    }

    drawPlayer(ctx, p, isBackground) {
        if (!isBackground) {
            ctx.shadowBlur = 20;
            ctx.shadowColor = p.color;
        }
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(Math.round(p.x), Math.round(p.y), p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    drawGlue(ctx, p) {
        const startX = p.stickPoint.x;
        const startY = p.stickPoint.y;

        ctx.save();
        ctx.beginPath();

        // Draw a blobby connection
        ctx.moveTo(startX - 10, startY);

        // Curve down to player left side
        ctx.quadraticCurveTo(startX, p.y - p.radius, p.x - p.radius * 0.5, p.y - p.radius * 0.8);

        ctx.lineTo(p.x + p.radius * 0.5, p.y - p.radius * 0.8);

        // Curve up to wall anchor right
        ctx.quadraticCurveTo(startX, p.y - p.radius, startX + 10, startY);

        ctx.closePath();

        ctx.fillStyle = Config.Colors.PLAYER;
        ctx.globalAlpha = 0.8;
        ctx.fill();

        // Glue Strands
        const dist = Math.abs(p.y - startY);
        if (dist > 10) {
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(p.x, p.y - p.radius);
            ctx.strokeStyle = '#ccffdd';
            ctx.lineWidth = Math.max(0.5, 4 - dist * 0.05);
            ctx.stroke();
        }

        ctx.restore();
    }

    drawAim(ctx, p, tilt, worldWidth) {
        const jumpAngle = tilt.angle + Math.PI;
        const maxLineLen = worldWidth * Config.Ratios.INDICATOR_LENGTH;
        const lineLen = (tilt.magnitude / 100) * maxLineLen;

        ctx.beginPath();
        ctx.moveTo(Math.round(p.x), Math.round(p.y));
        ctx.lineTo(Math.round(p.x + Math.cos(jumpAngle) * lineLen), Math.round(p.y + Math.sin(jumpAngle) * lineLen));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = Math.max(1, worldWidth * 0.003);
        ctx.setLineDash([worldWidth * 0.01, worldWidth * 0.01]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    drawTide(ctx, tide, width, isBackground) {
        const tideY = tide.y;

        ctx.fillStyle = tide.color;
        ctx.beginPath();
        ctx.moveTo(0, tideY + 1000);
        ctx.lineTo(0, tideY);

        const waveRes = width * 0.02;
        const waveAmp = width * Config.Ratios.TIDE_WAVE_AMP;
        const spikeHeight = width * Config.Ratios.TIDE_GLITCH_SPIKE;

        for (let x = 0; x <= width; x += waveRes) {
            let yOffset = Math.sin(x * 0.05 + tide.waveOffset) * waveAmp;
            if (Math.random() > 0.98) yOffset -= Math.random() * spikeHeight;
            ctx.lineTo(x, tideY + yOffset);
        }

        ctx.lineTo(width, tideY + 1000);
        ctx.closePath();

        const tideGrad = ctx.createLinearGradient(0, tideY, 0, tideY + 500);
        tideGrad.addColorStop(0, 'rgba(255, 0, 85, 0.6)');
        tideGrad.addColorStop(0.2, 'rgba(50, 0, 20, 0.9)');
        tideGrad.addColorStop(1, 'rgba(0, 0, 0, 1)');
        ctx.fillStyle = tideGrad;
        ctx.fill();

        if (!isBackground) {
            ctx.shadowBlur = Math.min(width * 0.02, 50);
            ctx.shadowColor = Config.Colors.TIDE_SHADOW;
            ctx.strokeStyle = Config.Colors.TIDE_STROKE;
            ctx.lineWidth = width * Config.Ratios.TIDE_LINE_WIDTH;
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else {
            ctx.save();
            ctx.strokeStyle = Config.Colors.TIDE_SHADOW;
            ctx.lineWidth = width * Config.Ratios.TIDE_LINE_WIDTH * 6;
            ctx.globalAlpha = 0.4;
            ctx.stroke();
            ctx.restore();

            ctx.strokeStyle = Config.Colors.TIDE_STROKE;
            ctx.lineWidth = width * Config.Ratios.TIDE_LINE_WIDTH;
            ctx.stroke();
        }
    }

    updateDangerUI(game) {
        const screenBottomY = game.camera.y + game.worldHeight;
        const proximity = game.tide.y - screenBottomY;
        const dangerZone = game.worldHeight * 0.3;

        if (proximity < dangerZone) {
            let intensity = 1 - ((proximity + game.worldHeight * 0.2) / (dangerZone + game.worldHeight * 0.2));
            intensity = Math.max(0, Math.min(1, intensity));

            const r = 255;
            const g = Math.floor(255 * (1 - intensity));
            const b = Math.floor(255 * (1 - intensity));
            const a = 0.3 + (intensity * 0.5);

            this.canvas.style.borderColor = `rgba(${r}, ${g}, ${b}, ${a})`;
            this.canvas.style.boxShadow = `0 0 ${5 + intensity * 5}vmin rgba(${r}, 0, 0, ${0.9 * intensity})`;
        } else {
            this.canvas.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            this.canvas.style.boxShadow = '0 0 5vmin rgba(0, 0, 0, 0.9)';
        }
    }
}

// --- Main Game Loop ---

class Game {
    constructor() {
        // UI Elements
        this.scoreEl = document.getElementById('score-value');
        this.finalScoreEl = document.getElementById('final-score');
        this.gameOverScreen = document.getElementById('game-over-screen');

        // System
        this.renderer = new Renderer(
            document.getElementById('gameCanvas'),
            document.getElementById('bg-canvas')
        );
        this.net = new NetworkManager();
        this.input = new InputManager(this.net);
        this.levelGen = new LevelGenerator();

        this.state = 'start';
        this.score = 0;
        this.lastTime = 0;
        this.frameCount = 0;

        this.worldWidth = 0;
        this.worldHeight = 0;
        this.lastWinW = 0;
        this.lastWinH = 0;

        // Entities
        this.player = new Player(0, 0);
        this.tide = new Tide(0);
        this.camera = new Camera();
        this.walls = [];
        this.scoreDivisor = 10;

        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('restart-btn').addEventListener('click', () => this.resetGame());

        this.net.on('readyToStart', () => {
            document.getElementById('connection-screen').classList.add('hidden');
            this.startGame();
        });

        this.net.on('data', (d) => {
            if (d.type === 'restart') {
                this.resetGame();
            }
        });

        this.input.onJump(() => {
            const jumped = this.player.jump(
                this.input.tiltVector.angle,
                this.input.tiltVector.magnitude,
                this.maxJumpForce,
                this.jumpForceMult
            );

            if (jumped && this.net.conn) {
                this.net.send({ type: 'vibrate', duration: Math.floor(this.input.tiltVector.magnitude * 0.5) });
            }
        });
    }

    /**
     * Entry Point
     */
    init() {
        const urlParams = new URLSearchParams(window.location.search);


        if (urlParams.get('host')) {
            // Controller Mode
            new ControllerApp(urlParams.get('host'));
            return;
        } else {
            // Host Mode
            this.net.initHost(
                document.getElementById('qrcode'),
                document.getElementById('connection-status')
            );
            document.getElementById('host-view').classList.remove('hidden');
        }

        this.resize();
        requestAnimationFrame((t) => this.loop(t));
    }

    startGame() {
        this.state = 'playing';
        this.resetEntities();
    }

    resetGame() {
        this.gameOverScreen.classList.add('hidden');
        this.score = 0;
        this.scoreEl.textContent = '0m';
        this.state = 'playing';
        this.resize();
        this.resetEntities();
    }

    resetEntities() {
        // Center player
        this.player.x = this.worldWidth / 2;
        this.player.y = this.worldHeight - 150;
        this.player.vx = 0;
        this.player.vy = 0;
        this.player.state = 'air';

        this.tide.y = this.worldHeight * (1 + Config.Ratios.TIDE_START_OFFSET);
        this.camera.y = 0;

        // Gen Floor & Walls
        const floorHeight = this.worldWidth * 0.15;
        const floorY = this.worldHeight - this.worldWidth * 0.1;

        this.walls = [new Wall(0, floorY, this.worldWidth, floorHeight, 'normal')];
        this.levelGen.reset(floorY);

        for (let i = 0; i < 15; i++) {
            this.walls.push(this.levelGen.generateNext(this.worldWidth));
        }
    }

    resize() {
        if (window.innerWidth === this.lastWinW && window.innerHeight === this.lastWinH) return;

        this.lastWinW = window.innerWidth;
        this.lastWinH = window.innerHeight;

        // Calculate Canvas Dimensions 
        const targetAspect = 13 / 16;
        const winAspect = window.innerWidth / window.innerHeight;
        let w, h;

        if (winAspect > targetAspect) {
            h = window.innerHeight;
            w = h * targetAspect;
        } else {
            w = window.innerWidth;
            h = w / targetAspect;
        }

        const oldWorldW = this.worldWidth;

        this.renderer.canvas.width = w;
        this.renderer.canvas.height = h;

        this.renderer.bgCanvas.width = window.innerWidth * Config.Visual.BG_SCALE_RES;
        this.renderer.bgCanvas.height = window.innerHeight * Config.Visual.BG_SCALE_RES;
        this.renderer.bgCtx.filter = Config.Visual.BG_BLUR;

        // World Dimensions
        this.worldWidth = w / Config.Visual.ZOOM;
        this.worldHeight = h / Config.Visual.ZOOM;

        // Scale Entities
        if (this.state !== 'start' && oldWorldW > 0) {
            const ratio = this.worldWidth / oldWorldW;
            this.player.resize(ratio);
            this.tide.y *= ratio;
            this.camera.y *= ratio;
            this.levelGen.highestY *= ratio;
            this.scoreDivisor *= ratio;
            this.walls.forEach(w => {
                w.x *= ratio; w.y *= ratio; w.w *= ratio; w.h *= ratio;
            });
        }

        // Update Size-Dependent Constants
        this.player.radius = this.worldWidth * Config.Ratios.PLAYER_RADIUS;
        this.gravity = this.worldWidth * Config.Ratios.GRAVITY;
        this.maxJumpForce = this.worldWidth * Config.Ratios.MAX_JUMP_FORCE;
        this.jumpForceMult = this.worldWidth * Config.Ratios.JUMP_FORCE_MULT;
        this.tide.speed = this.worldWidth * Config.Ratios.TIDE_SPEED;

        if (this.state === 'start') this.resetEntities();
    }

    loop(timestamp) {
        this.resize(); // Check resize every frame

        if (!this.lastTime) this.lastTime = timestamp;
        let dt = timestamp - this.lastTime;
        if (dt > 100) dt = 100; // Cap dt for pausing/tab switching
        this.lastTime = timestamp;

        const timeScale = dt / (1000 / 60);

        this.update(timeScale);
        this.renderer.draw(this);

        requestAnimationFrame((t) => this.loop(t));
    }

    update(timeScale) {
        if (this.state !== 'playing') return;

        this.tide.update(timeScale, this.player.y, this.worldWidth, this.worldHeight);

        // Check Tide Death
        if (this.player.y + this.player.radius > this.tide.y + this.worldWidth * Config.Ratios.TIDE_COLLISION_THRESHOLD) {
            this.gameOver();
        }

        this.updatePhysics(timeScale);

        // Camera
        const targetCamY = this.player.y - this.worldHeight * 0.6;
        const maxCamY = this.tide.y - this.worldHeight + this.worldHeight * Config.Ratios.CAMERA_LIMIT_PADDING;
        this.camera.update(targetCamY, timeScale, maxCamY);

        // Score
        const h = Math.floor(-this.player.y / this.scoreDivisor);
        if (h > this.score) {
            this.score = h;
            this.scoreEl.textContent = this.score + 'm';
        }

        if (this.camera.y < this.levelGen.highestY + this.worldHeight * Config.Ratios.GEN_TRIGGER_DIST) {
            this.walls.push(this.levelGen.generateNext(this.worldWidth));
        }
        // Cleanup walls below camera
        this.walls = this.walls.filter(w => w.y < this.camera.y + this.worldHeight + this.worldHeight * Config.Ratios.CLEANUP_DIST);
    }

    updatePhysics(timeScale) {
        if (this.player.state !== 'air' && this.player.state !== 'sticky') return;

        const subStepDt = (1 / Config.Visual.SUBSTEPS) * timeScale;

        this.player.updatePhysics(timeScale, this.gravity, Config.Visual.FRICTION);

        for (let i = 0; i < Config.Visual.SUBSTEPS; i++) {
            this.player.x += this.player.vx * subStepDt;
            this.player.y += this.player.vy * subStepDt;

            // Wall Collisions
            let collided = false;
            for (let w of this.walls) {
                const col = w.checkCollision(this.player);
                if (col) {
                    if (w.resolve(this.player, col)) {
                        collided = true;
                        break;
                    }
                }
            }
            if (collided) break;

            this.player.checkBounds(this.worldWidth);
        }

    }

    gameOver() {
        this.state = 'gameover';
        this.finalScoreEl.textContent = this.score + 'm';
        this.gameOverScreen.classList.remove('hidden');
        this.net.send({ type: 'gameover' });
    }
}

// --- Controller (Phone) ---

class ControllerApp {
    constructor(hostId) {
        this.setupUI();
        this.net = new NetworkManager();

        // UI Refs
        this.arrow = document.getElementById('arrow');
        this.jumpBtn = document.getElementById('jump-btn');
        this.startOverlay = document.getElementById('start-overlay');
        this.tiltVector = { x: 0, y: 0, magnitude: 0, angle: 0 };
        // EMA Filter State
        this.lastX = 0;
        this.lastY = 0;
        this.alpha = 0.8;

        this.init(hostId);
    }

    setupUI() {
        document.getElementById('controller-view').classList.remove('hidden');
        document.getElementById('host-view').classList.add('hidden');
    }

    init(hostId) {
        this.net.initController(hostId);

        this.net.on('connected', () => {
            this.startOverlay.style.display = 'flex';
        });

        this.net.on('data', (d) => {
            if (d.type === 'vibrate' && navigator.vibrate) {
                navigator.vibrate(d.duration);
            }
        });

        document.getElementById('enable-sensors-btn').addEventListener('click', () => this.requestPermissions());
    }

    requestPermissions() {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(resp => {
                    if (resp === 'granted') this.start();
                    else alert("Sensors required!");
                })
                .catch(console.error);
        } else {
            this.start();
        }
    }

    start() {
        this.startOverlay.style.display = 'none';

        window.addEventListener('deviceorientation', (e) => this.handleOrientation(e));

        const sendJump = (e) => {
            e.preventDefault();
            this.net.send({ type: 'jump' });
        };
        this.jumpBtn.addEventListener('touchstart', sendJump);
        this.jumpBtn.addEventListener('mousedown', sendJump);
    }

    handleOrientation(e) {
        let gamma = e.gamma || 0;
        let beta = e.beta || 0;

        // Apply EMA Filter
        gamma = this.alpha * gamma + (1 - this.alpha) * this.lastX;
        beta = this.alpha * beta + (1 - this.alpha) * this.lastY;

        this.lastX = gamma;
        this.lastY = beta;

        const x = gamma * Config.Visual.TILT_SENSITIVITY;
        const y = beta * Config.Visual.TILT_SENSITIVITY;

        const maxMag = 100;
        const mag = Math.min(Math.sqrt(x * x + y * y), maxMag);
        const angle = Math.atan2(y, x);

        this.tiltVector = { x, y, magnitude: mag, angle };

        this.updateUI();
        this.net.send({ type: 'tilt', vector: this.tiltVector });
    }

    updateUI() {
        const rotationDeg = (this.tiltVector.angle * 180 / Math.PI) + 270;
        const scale = this.tiltVector.magnitude / 50;
        this.arrow.style.transform = `rotate(${rotationDeg}deg) scaleY(${0.5 + scale * 0.5})`;
    }
}

new Game().init();