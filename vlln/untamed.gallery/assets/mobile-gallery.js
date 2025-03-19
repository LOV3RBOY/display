// Constant configuration values
const CHECK_THREE_INTERVAL = 100; // ms to poll for THREE availability
const IMAGE_ASPECT = 16 / 9;
const IMAGE_SIZE = 0.1;
const IMAGE_WIDTH = IMAGE_SIZE * IMAGE_ASPECT;
const IMAGE_HEIGHT = IMAGE_SIZE;
const GRID_COLS = 12;
const GRID_ROWS = 20; // there are actually 10 rows, but we are duplicating vertically
const TOTAL_IMAGES = GRID_COLS * GRID_ROWS / 2; // 120
const MAX_CONCURRENT_DOWNLOADS = 5;
const IMAGE_GAP = 0.01; // same gap horizontally and vertically
// higher zoom number means further away from screen
const DEFAULT_ZOOM = IMAGE_SIZE * 3; // default camera zoom
const MIN_ZOOM = IMAGE_SIZE; // how far we can zoom in
const MAX_ZOOM = IMAGE_SIZE * 5; // how far we can zoom out

const TAP_TIMEOUT = 200; // ms to wait for tap gesture

// Camera ortographic projection calculation at MIN_ZOOM level:
// Camera left/right are -1 to 1, up/down are calculated based on aspect ratio
// MIN_ZOOM level represents user viewing full images on screen.


// We'll pollute global namespace with some references.
window._galleryState = {
    scene: null,
    camera: null,
    renderer: null,
    canvas: null,
    imagesList: [],
    texturePromises: [],
    planes: [],
    targetPos: { x: 0, y: 0, z: DEFAULT_ZOOM },
    cameraPos: { x: 0, y: 0, z: MIN_ZOOM },
    isImagesLoaded: false,
    isCameraMoving: false,
    pinnedPlane: null,
    lastTapTime: 0,
    pinchStartDistance: 0,
    initialZoom: DEFAULT_ZOOM,
    isPinching: false,
    isPrimingCalled: false,
    isPrimingFinished: false,
};

// Start polling for THREE.
const waitForThree = setInterval(() => {
    if (window.THREE) {
        clearInterval(waitForThree);
        initGallery();
    }
}, CHECK_THREE_INTERVAL);

function initGallery() {
    const THREE = window.THREE;
    const state = window._galleryState;

    // Set up renderer
    state.canvas = document.getElementById('threejs-canvas');
    state.renderer = new THREE.WebGLRenderer({ canvas: state.canvas, antialias: true });
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.setClearColor(0x000000, 1);
    updateRendererSize();
    window.addEventListener('resize', updateRendererSize);

    // Orthographic camera
    // We'll compute left, right, top, bottom from actual canvas size and zoom
    // We'll keep camera at z=0 in 3D, but use camera.zoom for scaling.
    // near/far planes are arbitrary large.
    const aspect = state.canvas.clientWidth / state.canvas.clientHeight;
    state.camera = new THREE.OrthographicCamera(
        -aspect * state.cameraPos.z,
        aspect * state.cameraPos.z,
        state.cameraPos.z,
        -state.cameraPos.z,
        0.1,
        5
    );
    state.camera.position.set(0, 0, 1);
    state.camera.zoom = 1;
    state.camera.updateProjectionMatrix();
    state.camera.lookAt(new THREE.Vector3(0, 0, 0));

    // Create scene
    state.scene = new THREE.Scene();

    // Add loading overlay
    const loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'loading-overlay';

    const loadingText = document.createElement('p');
    loadingText.id = 'loading-text';
    loadingText.textContent = 'Loading...';
    loadingOverlay.appendChild(loadingText);

    // Set initial opacity
    state.canvas.style.opacity = '0.2';

    // Start fetching images list
    fetch('assets/images-list.txt')
        .then((resp) => resp.text())
        .then((text) => {
            state.imagesList = text.split(/\r?\n/).filter((line) => !!line);
            // We only expect 120 lines
            // We can load them with concurrency
            return loadAllTextures(state.imagesList);
        })
        .then((textures) => {
            // Now we have all textures, let's create planes
            createImagePlanes(textures);
            state.isImagesLoaded = true;
        })
        .catch((err) => {
            console.error('Error fetching or loading images list:', err);
        });

    // Pre-load all images to GPU
    function primeImages() {
        // After priming, set loaded state and initialize event listeners
        state.isPrimingCalled = true;

        setTimeout(() => {
            // Disable culling so the GPU won't skip out-of-view planes
            state.planes.forEach((plane) => {
                plane.frustumCulled = false;
            });

            // Force a “prime” render
            state.renderer.render(state.scene, state.camera);

            // Optionally re-enable culling if you like
            state.planes.forEach((plane) => {
                plane.frustumCulled = true;
            });

            // Remove loading overlay
            loadingOverlay.style.opacity = '0';
            setTimeout(() => {
                loadingOverlay.remove();
            }, 200);

            // Set final opacity
            state.canvas.style.opacity = '1.0';

            // Add event listeners now that we're loaded
            state.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
            state.canvas.addEventListener('touchmove', onTouchMove, { passive: false });
            state.canvas.addEventListener('touchend', onTouchEnd, { passive: false });
            state.isPrimingFinished = true;
        }, 100);
    }

    // Set up event listeners for touch
    let lastTime = performance.now();
    function animate() {
        const now = performance.now();
        const deltaTime = Math.max(0.0001, (now - lastTime) / 1000); // in seconds, never 0
        lastTime = now;

        updateFrame(deltaTime);

        // Add visibility check
        checkVisibility();

        requestAnimationFrame(animate);
    }

    let wasLoadingEverShown = false;

    function checkVisibility() {
        if (scrollFraction >= 0.999) {
            state.canvas.style.opacity = state.isPrimingFinished ? '1' : '0.2';
        }

        if (scrollFraction >= 0.999 && !document.body.contains(loadingOverlay) && !wasLoadingEverShown) {
            document.body.appendChild(loadingOverlay);
            setTimeout(() => {
                loadingOverlay.style.opacity = '1';
            }, 1);
            wasLoadingEverShown = true;
        }

        if (scrollFraction >= 0.999 && !state.isPrimingCalled && state.isImagesLoaded) {
            primeImages();
        }
    }
    animate();

    //--- Functions ---//

    function updateRendererSize() {
        if (!state.renderer) return;
        const width = state.canvas.clientWidth;
        const height = state.canvas.clientHeight;
        state.renderer.setSize(width, height, false);
    }

    function loadAllTextures(list) {
        // Convert image names to full urls
        const urls = list.map((name) => `assets/images/optimized/${name}`);

        const textureLoader = new THREE.TextureLoader();

        return new Promise((resolve) => {
            const results = new Array(urls.length);
            let inFlight = 0;
            let index = 0;
            let loadedCount = 0;

            function loadNext() {
                if (index >= urls.length) {
                    return;
                }
                const currentIndex = index;
                const url = urls[currentIndex];
                index++;
                inFlight++;

                textureLoader.load(
                    url,
                    (texture) => {
                        texture.colorSpace = THREE.SRGBColorSpace;
                        results[currentIndex] = texture;
                        inFlight--;
                        loadedCount++;
                        if (loadedCount === urls.length) {
                            resolve(results);
                        } else {
                            loadSome();
                        }
                    },
                    undefined,
                    (err) => {
                        console.error('Error loading texture:', url, err);
                        results[currentIndex] = null;
                        inFlight--;
                        loadedCount++;
                        if (loadedCount === urls.length) {
                            resolve(results);
                        } else {
                            loadSome();
                        }
                    }
                );
            }

            function loadSome() {
                while (inFlight < MAX_CONCURRENT_DOWNLOADS && index < urls.length) {
                    loadNext();
                }
            }

            loadSome();
        });
    }

    function createImagePlanes(textures) {
        // We'll lay them out in a 12x10 grid.
        // Each plane has 16:9 aspect ratio.
        // We'll place the top-left plane roughly at x=0,y=0, going right (x increasing),
        // then down (y decreasing). Or we can center them around (0,0).

        // Let's compute total width and total height
        const totalWidth = GRID_COLS * (IMAGE_WIDTH + IMAGE_GAP) - IMAGE_GAP; // only 11 gaps on 12 items
        const totalHeight = GRID_ROWS * (IMAGE_HEIGHT + IMAGE_GAP) - IMAGE_GAP; // 9 gaps on 10 items

        // We'll center the entire grid at (0,0)
        const startX = -totalWidth / 2 + IMAGE_WIDTH / 2;
        const startY = totalHeight / 2 - IMAGE_HEIGHT / 2;

        // Create random vertical offsets for each column
        const columnOffsets = new Array(GRID_COLS);
        for (let col = 0; col < GRID_COLS; col++) {
            columnOffsets[col] = (Math.random() - 0.5) * IMAGE_HEIGHT; // Random offset between -0.5 to +0.5 image height
        }

        const geometry = new THREE.PlaneGeometry(IMAGE_WIDTH, IMAGE_HEIGHT);

        // We duplicate images vertically
        for (let rowRepeat = 0; rowRepeat < 2; rowRepeat++) {
            for (let i = 0; i < textures.length; i++) {
                const texture = textures[i];
                if (!texture) continue; // skip missing

                const col = i % GRID_COLS;
                const row = Math.floor(i / GRID_COLS) + rowRepeat * GRID_ROWS / 2;

                // position with column offset
                const x = startX + col * (IMAGE_WIDTH + IMAGE_GAP);
                const y = startY - row * (IMAGE_HEIGHT + IMAGE_GAP) + columnOffsets[col];

                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    side: THREE.DoubleSide,
                    opacity: 1.0,
                    toneMapped: false,
                });

                const plane = new THREE.Mesh(geometry, material);
                plane.position.set(x, y, 0);
                // We'll store extra info on plane
                plane.userData = {
                    col,
                    row,
                    centerX: x,
                    centerY: y,
                };

                state.scene.add(plane);
                state.planes.push(plane);
            }
        }
    }

    // Track touch positions for proper panning
    let touchStartPos = { x: 0, y: 0 };
    let lastTouchPos = { x: 0, y: 0 };
    let isDragging = false;

    let pendingTapTimeout = null;
    let blockPickingImages = false;

    function onTouchStart(e) {
        e.preventDefault();

        if (e.touches.length === 1) {
            const touch = e.touches[0];
            const now = Date.now();

            // Track initial touch position
            touchStartPos.x = touch.clientX;
            touchStartPos.y = touch.clientY;
            lastTouchPos.x = touch.clientX;
            lastTouchPos.y = touch.clientY;

            // Check for double tap
            if (now - state.lastTapTime < TAP_TIMEOUT) {
                onDoubleTap(e);
                state.lastTapTime = 0; // Reset to prevent triple-tap
            } else {
                state.lastTapTime = now;
                isDragging = true;
            }
        } else if (e.touches.length === 2) {
            // Start pinch zoom
            state.isPinching = true;
            state.pinchStartDistance = getDistance(e.touches[0], e.touches[1]);
            state.initialZoom = state.targetPos.z;
        }
    }

    function onTouchMove(e) {
        e.preventDefault();

        if (e.touches.length === 1 && !state.isPinching && isDragging) {
            const touch = e.touches[0];

            // Calculate movement in screen space
            const dx = touch.clientX - lastTouchPos.x;
            const dy = touch.clientY - lastTouchPos.y;

            // Update last position
            lastTouchPos.x = touch.clientX;
            lastTouchPos.y = touch.clientY;

            // Convert screen movement to world movement
            const aspect = state.canvas.clientWidth / state.canvas.clientHeight;
            const worldDx = (dx / state.canvas.clientWidth) * 3 * state.cameraPos.z;
            const worldDy = (dy / state.canvas.clientHeight / aspect) * 3 * state.cameraPos.z;

            // Update target position
            state.targetPos.x -= worldDx;
            state.targetPos.y += worldDy;

        } else if (e.touches.length === 2 && state.isPinching) {
            // Handle pinch zoom
            const newDist = getDistance(e.touches[0], e.touches[1]);
            const scale = state.pinchStartDistance / newDist; // Inverted scale

            // Apply zoom with exponential scaling for better feel
            state.targetPos.z = state.initialZoom * Math.pow(scale, 1.5);
        }
    }

    function onTouchEnd(e) {
        e.preventDefault();

        if (e.touches.length === 0) {
            // Handle tap/click if it wasn't a drag
            if (!state.isPinching) {
                const touch = e.changedTouches[0];
                const dx = touch.clientX - touchStartPos.x;
                const dy = touch.clientY - touchStartPos.y;

                // Only consider it a tap if movement was small
                if (Math.sqrt(dx * dx + dy * dy) < 10 && !blockPickingImages) {
                    // Start single-tap timeout
                    pendingTapTimeout = setTimeout(() => {
                        if (!blockPickingImages) {
                            pickImage(touch.clientX, touch.clientY);
                        }
                    }, (state.targetPos.z == DEFAULT_ZOOM) ? 0 : TAP_TIMEOUT);
                }
            }

            state.isPinching = false;
            isDragging = false;
        }
    }

    function onDoubleTap(e) {
        console.log("DOUBLE TAP")
        // reset zoom
        clearTimeout(pendingTapTimeout);
        pendingTapTimeout = null;
        state.targetPos.z = DEFAULT_ZOOM;

        // Block image picking for tap duration
        blockPickingImages = true;
        setTimeout(() => {
            blockPickingImages = false;
        }, TAP_TIMEOUT);
    }

    function clampZoom() {
        // Keep zoom within bounds
        state.targetPos.z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.targetPos.z));
    }

    function getDistance(touch1, touch2) {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function pickImage(clientX, clientY) {
        console.log("PICK IMAGE")
        const rect = state.canvas.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -(((clientY - rect.top) / rect.height) * 2 - 1);

        const mouse = new THREE.Vector2(x, y);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        // Sort planes by distance to ensure we get the frontmost one
        const intersects = raycaster.intersectObjects(state.planes)
            .sort((a, b) => a.distance - b.distance);

        if (intersects.length > 0) {
            const plane = intersects[0].object;

            // Center on the image
            state.targetPos.x = plane.position.x;
            state.targetPos.y = plane.position.y;

            // Zoom to fit the image
            state.targetPos.z = MIN_ZOOM;
        }
    }

    function updateFrame(deltaTime) {
        if (!state.isImagesLoaded) {
            return; // don't render yet
        }

        // Smooth camera movement with delta time
        const lerpFactor = 5.0; // Higher base factor since we're using delta time
        const t = 1.0 - Math.pow(0.1, deltaTime * lerpFactor); // Frame-rate independent lerp
        clampZoom();

        state.cameraPos.x += (state.targetPos.x - state.cameraPos.x) * t;
        state.cameraPos.y += (state.targetPos.y - state.cameraPos.y) * t;
        state.cameraPos.z += (state.targetPos.z - state.cameraPos.z) * t * 0.4;

        // Update camera
        const aspect = window.innerWidth / window.innerHeight;
        state.camera.left = -state.cameraPos.z;
        state.camera.right = state.cameraPos.z;
        state.camera.top = state.cameraPos.z / aspect;
        state.camera.bottom = -state.cameraPos.z / aspect;

        state.camera.position.set(state.cameraPos.x, state.cameraPos.y, 1);
        state.camera.zoom = 1.0;
        state.camera.lookAt(new THREE.Vector3(state.cameraPos.x, state.cameraPos.y, 0));
        state.camera.aspect = aspect;
        state.camera.updateProjectionMatrix();
        state.renderer.setSize(window.innerWidth, window.innerHeight);

        // Calculate total grid dimensions
        const totalWidth = GRID_COLS * (IMAGE_WIDTH + IMAGE_GAP);
        const totalHeight = GRID_ROWS * (IMAGE_HEIGHT + IMAGE_GAP);

        // Update image positions and opacities
        for (const plane of state.planes) {
            // Calculate distance from camera center
            const dx = plane.position.x - state.cameraPos.x;
            const dy = plane.position.y - state.cameraPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Update opacity based on distance
            const fadeStart = 0;
            const fadeEnd = state.cameraPos.z * 2;
            let opacity = 1.0 - (dist - fadeStart) / (fadeEnd - fadeStart);
            opacity = Math.max(0.2, Math.min(1.0, opacity));
            plane.material.opacity = opacity;

            // Calculate camera-relative position
            const relX = plane.position.x - state.cameraPos.x;
            const relY = plane.position.y - state.cameraPos.y;

            // Wrap horizontally
            if (relX > totalWidth / 2) {
                plane.position.x -= totalWidth;
            } else if (relX < -totalWidth / 2) {
                plane.position.x += totalWidth;
            }

            // Wrap vertically
            if (relY > totalHeight / 2) {
                plane.position.y -= totalHeight;
            } else if (relY < -totalHeight / 2) {
                plane.position.y += totalHeight;
            }
        }

        state.renderer.render(state.scene, state.camera);
    }
}
