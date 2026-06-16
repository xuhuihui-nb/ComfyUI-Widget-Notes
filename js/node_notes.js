import { app } from "../../scripts/app.js";

console.log("ComfyUI-NodeNotes: Loading extension with Object.defineProperty compatibility fix");

// WeakMap to keep track of wrapped widgets to prevent recursive nesting recursion
const wrappedWidgets = new WeakMap();

// ---------------------------------------------------------------------------
// Exclusion list: these 4 categories of nodes are skipped entirely.
// 1. Image preview nodes  2. Image load nodes
// 3. 3-D model preview nodes  4. Note / annotation nodes
// ---------------------------------------------------------------------------

/** Exact class_type names that should be excluded */
const EXCLUDED_NODE_TYPES = new Set([
    // ── Image preview ──────────────────────────────────────────────
    "PreviewImage",
    "SaveImage",
    "ImagePreviewFromLatent+",
    "MaskPreview+",
    "AiLab_Preview",
    "AiLab_ImagePreview",
    "AiLab_MaskPreview",
    "TextPreview",
    "PreviewAudio",
    // ── Image load ─────────────────────────────────────────────────
    "LoadImage",
    "LoadImageMask",
    "LoadImageOutput",
    "LoadImageWithSwitch",
    "LoadImageMaskWithSwitch",
    "LoadImageWithoutListDir",
    "LoadImageMaskWithoutListDir",
    "AiLab_LoadImage",
    "Load3D",
    "Load3DAnimation",
    // ── 3-D model preview ──────────────────────────────────────────
    "Preview3D",
    "Preview3DAnimation",
    // ── Note / annotation (ComfyUI built-in) ───────────────────────
    "Note",
]);

/**
 * Returns true if the plugin should leave this node completely untouched.
 * Matches against the exact class_type set above, and also against
 * name patterns so that future variants are caught automatically.
 */
function isExcludedNode(node) {
    if (!node) return false;

    // Resolve the node's class identifier (works for regular nodes and group nodes)
    const classType = node.comfyClass || node.type || "";

    // 1. Exact match
    if (EXCLUDED_NODE_TYPES.has(classType)) return true;

    // 2. Pattern match for forward-compatibility
    //    - Preview image: ends with or contains "PreviewImage", "ImagePreview", "MaskPreview"
    //    - Load image:    starts with "LoadImage" or "Load3D"
    //    - 3D preview:    starts with "Preview3D"
    //    - Note:          exact "Note" (already in set) or type === "Note"
    if (
        /PreviewImage$/.test(classType) ||
        /ImagePreview$/.test(classType) ||
        /MaskPreview/.test(classType)   ||
        /^LoadImage/.test(classType)    ||
        /^Load3D/.test(classType)       ||
        /^Preview3D/.test(classType)    ||
        node.type === "Note"
    ) {
        return true;
    }

    return false;
}
// ---------------------------------------------------------------------------

// Helper function to draw wrapped text with CJK and English support
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
    const lines = text.split('\n');
    let currentY = y;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) {
            currentY += lineHeight;
            continue;
        }
        
        // Tokenize into English words or CJK characters to wrap nicely at word boundaries for English
        // and character boundaries for Chinese/Japanese/Korean
        const tokens = line.match(/[\d\w_]+|[^\d\w_]/g) || [];
        let currentLine = '';
        
        for (let j = 0; j < tokens.length; j++) {
            const token = tokens[j];
            const testLine = currentLine + token;
            const metrics = ctx.measureText(testLine);
            
            if (metrics.width > maxWidth) {
                if (currentLine === '') {
                    ctx.fillText(token, x, currentY);
                    currentY += lineHeight;
                } else {
                    ctx.fillText(currentLine, x, currentY);
                    currentLine = token;
                    currentY += lineHeight;
                }
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine !== '') {
            ctx.fillText(currentLine, x, currentY);
            currentY += lineHeight;
        }
    }
}

// Helper function to calculate the total height of wrapped text
function calculateTextHeight(ctx, text, maxWidth, lineHeight) {
    if (!text) return 0;
    const lines = text.split('\n');
    let totalLinesCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) {
            totalLinesCount++;
            continue;
        }
        
        const tokens = line.match(/[\d\w_]+|[^\d\w_]/g) || [];
        let currentLine = '';
        let lineCountForThisParagraph = 1;
        
        for (let j = 0; j < tokens.length; j++) {
            const token = tokens[j];
            const testLine = currentLine + token;
            const metrics = ctx.measureText(testLine);
            
            if (metrics.width > maxWidth) {
                if (currentLine === '') {
                    lineCountForThisParagraph++;
                } else {
                    lineCountForThisParagraph++;
                    currentLine = token;
                }
            } else {
                currentLine = testLine;
            }
        }
        totalLinesCount += lineCountForThisParagraph;
    }
    
    return totalLinesCount * lineHeight;
}

// Resolve proxy widget to its inner node and widget inside subgraphs/Group Nodes
function resolveInnerWidgetInfo(node, widget) {
    if (!widget) return { node, widget };
    
    // Check if widget is a PromotedWidgetView (proxy widget for Group Nodes)
    if (typeof widget.resolveDeepest === "function") {
        try {
            const deepest = widget.resolveDeepest();
            if (deepest && deepest.node && deepest.widget) {
                return { node: deepest.node, widget: deepest.widget };
            }
        } catch (err) {
            console.error("Error in widget.resolveDeepest:", err);
        }
    }
    
    // Fallback: Check if GroupNodeHandler is registered and can map it
    const GroupNodeHandler = window.comfyAPI?.groupNode?.GroupNodeHandler;
    if (node && GroupNodeHandler && GroupNodeHandler.isGroupNode(node)) {
        const handler = GroupNodeHandler.getHandler(node);
        if (handler && handler.innerNodes && handler.groupData && handler.groupData.newToOldWidgetMap) {
            const mapping = handler.groupData.newToOldWidgetMap[widget.name];
            if (mapping) {
                const innerNodeIdx = mapping.node.index ?? 0;
                const innerNode = handler.innerNodes[innerNodeIdx];
                if (innerNode && innerNode.widgets) {
                    const innerWidget = innerNode.widgets.find(w => w.name === mapping.inputName);
                    if (innerWidget) {
                        return { node: innerNode, widget: innerWidget };
                    }
                }
            }
        }
    }
    
    return { node, widget };
}

// Safe helper function to fetch parameter note settings without risking properties TypeErrors
function getWidgetNoteInfo(node, widget) {
    const resolved = resolveInnerWidgetInfo(node, widget);
    const targetNode = resolved.node;
    const targetWidget = resolved.widget;
    
    if (!targetNode || !targetWidget || !targetWidget.name || !targetNode.properties || !targetNode.properties.parameterNotes) {
        return { text: "", height: 2, fontSize: 11 };
    }
    const info = targetNode.properties.parameterNotes[targetWidget.name];
    if (!info) {
        return { text: "", height: 2, fontSize: 11 };
    }
    return {
        text: info.text || "",
        height: (info.height !== undefined && !isNaN(info.height)) ? info.height : 2,
        fontSize: (info.fontSize !== undefined && !isNaN(info.fontSize)) ? info.fontSize : 11
    };
}

// Safe helper function to get widget Y position, prioritizing last_y (actual rendered Y position)
// since widget.y might be undefined or 0 for dynamically created/managed widgets (like in Subgraphs/GroupNodes)
function getWidgetY(widget) {
    if (widget.last_y !== undefined && widget.last_y !== null && !isNaN(widget.last_y)) {
        return widget.last_y;
    }
    if (widget.y !== undefined && widget.y !== null && !isNaN(widget.y)) {
        return widget.y;
    }
    return 0;
}

// Compute the effective note area height for a widget.
// In Group Nodes / subgraphs, the inner widget's overridden computeSize leaks noteHeight
// into the proxy widget's computedHeight even though the group node itself has no
// parameterNotes data (so noteHeight reads as 2/collapsed).  We detect this by comparing
// computedHeight against the widget's expected base height (~24px = NODE_WIDGET_HEIGHT+4)
// and use the larger of the two values so clicks/dblclicks in the blank space are correctly
// intercepted instead of falling through to the actual widget.
function getEffectiveNoteHeight(widget, noteHeight) {
    if (widget && widget.computedHeight !== undefined && !isNaN(widget.computedHeight)) {
        // Estimate base widget height: NODE_WIDGET_HEIGHT(20) + 4 margin = 24
        const BASE_WIDGET_H = 24;
        const leakedHeight = Math.max(0, widget.computedHeight - BASE_WIDGET_H);
        return Math.max(noteHeight, leakedHeight);
    }
    return noteHeight;
}



// Function to open the editor for parameter note widgets
function openParameterNoteEditor(node, widget) {
    if (document.getElementById("comfy-node-note-editor")) {
        return;
    }
    
    const canvasInstance = app.canvas;
    const scale = canvasInstance.ds.scale;
    const offset = canvasInstance.ds.offset;
    const boundingRect = canvasInstance.canvas.getBoundingClientRect();
    
    const targetWidget = node.widgets.find(w => w.name === widget.targetWidgetName);
    if (!targetWidget) return;
    
    const noteInfo = getWidgetNoteInfo(node, targetWidget);
    const noteHeight = noteInfo.height;
    
    const w_normal_height = (targetWidget.computedHeight !== undefined)
        ? Math.max(0, targetWidget.computedHeight - noteHeight)
        : 20;
    const widgetY = getWidgetY(targetWidget) + w_normal_height;
    
    const editorH = Math.max(45, widget.height);
    
    const screenX = boundingRect.left + (node.pos[0] + 8 + offset[0]) * scale;
    const screenY = boundingRect.top + (node.pos[1] + widgetY + offset[1]) * scale;
    const screenW = ((node.size[0] || 200) - 16) * scale;
    const screenH = editorH * scale;
    
    const textarea = document.createElement("textarea");
    textarea.id = "comfy-node-note-editor";
    textarea.value = widget.value || "";
    
    // Style the textarea to blend nicely with ComfyUI dark theme
    textarea.style.position = "absolute";
    textarea.style.left = `${screenX}px`;
    textarea.style.top = `${screenY}px`;
    textarea.style.width = `${screenW}px`;
    textarea.style.height = `${screenH}px`;
    textarea.style.zIndex = 10000;
    textarea.style.boxSizing = "border-box";
    textarea.style.background = "rgba(18, 18, 18, 0.95)";
    textarea.style.color = "#f1f5f9";
    textarea.style.border = "1px dashed #64748b";
    textarea.style.borderRadius = "4px";
    textarea.style.outline = "none";
    textarea.style.resize = "none";
    textarea.style.font = `${Math.max(10, 11 * scale)}px Arial, sans-serif`;
    textarea.style.lineHeight = `${14 * scale}px`;
    textarea.style.padding = `${5 * scale}px`;
    textarea.style.fontFamily = "sans-serif";
    textarea.placeholder = "输入参数注释...\n(Ctrl+Enter 确认，Esc 取消)";
    
    document.body.appendChild(textarea);
    
    let finished = false;
    const saveAndClose = () => {
        if (finished) return;
        finished = true;
        
        const text = textarea.value.trim();
        widget.value = text;
        widget._noteScrollY = 0; // Reset scroll position on edit
        
        if (text) {
            if (widget.height <= 4) {
                widget.height = 45; // Default expanded height
            }
        } else {
            widget.height = 2; // Collapse if text is empty
        }
        
        // Adjust node size safely, strictly avoiding NaN corruption
        let min_h = 50;
        try {
            if (node.computeSize) {
                const sz = node.computeSize();
                if (sz && !isNaN(sz[1])) {
                    min_h = sz[1];
                }
            }
        } catch (err) {
            console.error("Error computing size on save parameter note:", err);
        }
        if (node.size && !isNaN(node.size[1])) {
            node.size[1] = Math.max(min_h, node.size[1]);
        }
        
        canvasInstance.draw(true, true);
        cleanup();
    };
    
    const cancelAndClose = () => {
        if (finished) return;
        finished = true;
        cleanup();
    };
    
    const cleanup = () => {
        window.removeEventListener("wheel", handleScroll);
        if (textarea.parentNode) {
            textarea.parentNode.removeChild(textarea);
        }
    };
    
    const handleScroll = () => {
        saveAndClose();
    };
    
    window.addEventListener("wheel", handleScroll, { passive: true });
    
    // Defer focus and blur binding to prevent instant focus stealing from double-click/mousedown event bubbling
    setTimeout(() => {
        if (textarea.parentNode) {
            textarea.focus();
            textarea.select();
            textarea.addEventListener("blur", saveAndClose);
        }
    }, 50);
    
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            saveAndClose();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancelAndClose();
        }
    });
}

// Create virtual note widgets to intercept interactions without modifying node.widgets
function createVirtualNoteWidget(node, targetWidget) {
    const resolved = resolveInnerWidgetInfo(node, targetWidget);
    const actualNode = resolved.node;
    const actualWidget = resolved.widget;
    
    return {
        name: `__note_for_${targetWidget.name}`,
        type: "parameter_note",
        targetWidgetName: targetWidget.name,
        
        get value() {
            return getWidgetNoteInfo(actualNode, actualWidget).text;
        },
        set value(val) {
            if (!actualNode.properties) actualNode.properties = {};
            if (!actualNode.properties.parameterNotes) actualNode.properties.parameterNotes = {};
            if (!actualNode.properties.parameterNotes[actualWidget.name]) {
                actualNode.properties.parameterNotes[actualWidget.name] = { height: 2 };
            }
            actualNode.properties.parameterNotes[actualWidget.name].text = val;
        },
        
        get height() {
            return getWidgetNoteInfo(actualNode, actualWidget).height;
        },
        set height(val) {
            if (!actualNode.properties) actualNode.properties = {};
            if (!actualNode.properties.parameterNotes) actualNode.properties.parameterNotes = {};
            if (!actualNode.properties.parameterNotes[actualWidget.name]) {
                actualNode.properties.parameterNotes[actualWidget.name] = { text: "" };
            }
            const oldHeight = actualNode.properties.parameterNotes[actualWidget.name].height || 2;
            actualNode.properties.parameterNotes[actualWidget.name].height = val;
            
            // Adjust inner node's size if actualNode is different from the outer Group Node
            if (actualNode !== node && actualNode.size && !isNaN(actualNode.size[1])) {
                let min_h = 50;
                try {
                     if (actualNode.computeSize) {
                         const sz = actualNode.computeSize();
                         if (sz && !isNaN(sz[1])) min_h = sz[1];
                     }
                } catch (err) {}
                const deltaHeight = val - oldHeight;
                const d_h = !isNaN(deltaHeight) ? deltaHeight : 0;
                actualNode.size[1] = Math.max(min_h, actualNode.size[1] + d_h);
            }
        },
        
        get fontSize() {
            return getWidgetNoteInfo(actualNode, actualWidget).fontSize;
        },
        set fontSize(val) {
            if (!actualNode.properties) actualNode.properties = {};
            if (!actualNode.properties.parameterNotes) actualNode.properties.parameterNotes = {};
            if (!actualNode.properties.parameterNotes[actualWidget.name]) {
                actualNode.properties.parameterNotes[actualWidget.name] = { text: "", height: 2 };
            }
            actualNode.properties.parameterNotes[actualWidget.name].fontSize = val;
        },
        
        mouse: function(event, pos, node) {
            const targetWidget = node.widgets.find(w => w && w.name === this.targetWidgetName);
            if (!targetWidget) return false;
            
            const effectiveNoteHeight = getEffectiveNoteHeight(targetWidget, this.height);
            const w_normal_height = (targetWidget.computedHeight !== undefined)
                ? Math.max(0, targetWidget.computedHeight - effectiveNoteHeight)
                : 20;
            const widgetY = getWidgetY(targetWidget) + w_normal_height;
            const widgetMaxY = widgetY + effectiveNoteHeight;
            
            const isDown = event.type === "mousedown" || event.type === "pointerdown";
            const isMove = event.type === "mousemove" || event.type === "pointermove";
            const isUp = event.type === "mouseup" || event.type === "pointerup";
            
            if (isDown) {
                const isResizeHit = effectiveNoteHeight <= 4 
                    ? (pos[1] >= widgetY - 4 && pos[1] <= widgetMaxY + 4)
                    : (pos[1] >= widgetMaxY - 6 && pos[1] <= widgetMaxY + 3);
                
                if (isResizeHit) {
                    this._is_dragging = true;
                    this._drag_start_y = pos[1];
                    this._drag_start_height = this.height;
                    this._drag_moved = false;
                } else {
                    this._is_dragging = false;
                    this._drag_moved = false;
                }
                return true;
            } else if (isMove) {
                if (this._is_dragging) {
                    const deltaY = pos[1] - this._drag_start_y;
                    if (Math.abs(deltaY) > 2) {
                        this._drag_moved = true;
                    }
                    let newHeight = this._drag_start_height + deltaY;
                    
                    if (newHeight < 8) {
                        newHeight = 2;
                    } else if (newHeight > 300) {
                        newHeight = 300;
                    }
                    
                    const deltaHeight = newHeight - this.height;
                    this.height = newHeight;
                    
                    // Adjust node size safely, strictly avoiding NaN corruption
                    let min_h = 50;
                    try {
                        if (node.computeSize) {
                            const sz = node.computeSize();
                            if (sz && !isNaN(sz[1])) {
                                min_h = sz[1];
                            }
                        }
                    } catch (err) {
                        console.error("Error computing size on drag:", err);
                    }
                    
                    const node_h = (node.size && !isNaN(node.size[1])) ? node.size[1] : min_h;
                    const d_h = !isNaN(deltaHeight) ? deltaHeight : 0;
                    const new_h = Math.max(min_h, node_h + d_h);
                    node.size[1] = new_h;
                    
                    node.graph.setDirtyCanvas(true);
                    return true;
                }
            } else if (isUp) {
                const wasDragged = this._is_dragging && this._drag_moved;
                if (this._is_dragging) {
                    this._is_dragging = false;
                    node.graph.setDirtyCanvas(true);
                }
                
                const canvasInstance = app.canvas;
                if (canvasInstance && canvasInstance.node_widget && canvasInstance.node_widget[1] === this) {
                    canvasInstance.node_widget = null;
                }
                
                // Double click anywhere in the notes area or note line to edit (only if not dragged)
                if (!wasDragged) {
                    const now = Date.now();
                    const lastClickTime = this._last_click_time || 0;
                    this._last_click_time = now;
                    
                    if (now - lastClickTime < 300) {
                        openParameterNoteEditor(node, this);
                        return true;
                    }
                }
                return true;
            }
            return false;
        }
    };
}

function getOrCreateVirtualNoteWidget(node, targetWidget) {
    if (!node._virtualNoteWidgets) {
        node._virtualNoteWidgets = {};
    }
    if (!node._virtualNoteWidgets[targetWidget.name]) {
        node._virtualNoteWidgets[targetWidget.name] = createVirtualNoteWidget(node, targetWidget);
    }
    return node._virtualNoteWidgets[targetWidget.name];
}

// Wrapper for widget computeSize to create gap spacing for parameter notes
function wrapWidgetComputeSize(widget, node) {
    if (!widget || wrappedWidgets.has(widget)) return; // already wrapped
    
    // Do not wrap computeSize on proxy widgets (PromotedWidgetView) to avoid double-adding noteHeight.
    // They already delegate computeSize to the inner node's widget which is already wrapped.
    if (widget.resolveDeepest !== undefined || widget.subgraphNode !== undefined) {
        return;
    }
    
    const originalComputeSize = widget.computeSize;
    wrappedWidgets.set(widget, originalComputeSize || null);
    
    const newComputeSize = function(width) {
        let sz;
        try {
            if (originalComputeSize) {
                sz = originalComputeSize.call(this, width);
            }
        } catch (err) {
            console.error("Error calling original widget computeSize:", err);
        }
        
        // Safe fallback if sz is invalid or not an array/object
        if (!sz || typeof sz !== "object" || typeof sz.length !== "number" || sz.length < 2) {
            sz = [width || 200, 20];
        }
        
        let noteHeight = 2;
        try {
            noteHeight = getWidgetNoteInfo(node, widget).height;
        } catch (err) {
            console.error("Error getting widget note height:", err);
        }
        
        // Ensure values are numbers and not NaN to prevent node size corruption
        let w_val = (sz[0] !== undefined && !isNaN(sz[0])) ? sz[0] : (width || 200);
        let h_val = (sz[1] !== undefined && !isNaN(sz[1])) ? sz[1] : 20;
        
        return [w_val, h_val + noteHeight];
    };

    try {
        Object.defineProperty(widget, "computeSize", {
            value: newComputeSize,
            writable: true,
            configurable: true
        });
    } catch (err) {
        console.error("Error defining computeSize property via Object.defineProperty:", err);
        // Fallback to direct assignment
        widget.computeSize = newComputeSize;
    }
}

function wrapAllNodeWidgets(node) {
    if (isExcludedNode(node)) return; // skip excluded node categories
    try {
        if (node && node.widgets) {
            for (let w of node.widgets) {
                if (!w) continue;
                wrapWidgetComputeSize(w, node);
            }
        }
    } catch (err) {
        console.error("Error in wrapAllNodeWidgets:", err);
    }
}

// Set up the note functionality on a node instance
function setupNodeNotes(node, canvasInstance) {
    if (!node) return;
    if (isExcludedNode(node)) return; // skip excluded node categories
    if (node.__nodeNotesSetup) return;
    node.__nodeNotesSetup = true;

    // Sanitize saved/loaded parameter note heights to heal any corrupted layouts
    let hadReset = false;
    if (node.properties && node.properties.parameterNotes) {
        for (let key in node.properties.parameterNotes) {
            const info = node.properties.parameterNotes[key];
            if (info && info.height !== undefined) {
                if (isNaN(info.height) || info.height > 300 || info.height < 2) {
                    info.height = 2; // Reset corrupted height
                    hadReset = true;
                }
            }
        }
    }
    
    // If we resolved a corrupted height, restore node height to its minimum size
    if (hadReset) {
        let min_h = 50;
        try {
            if (node.computeSize) {
                const sz = node.computeSize();
                if (sz && !isNaN(sz[1])) {
                    min_h = sz[1];
                }
            }
        } catch (err) {
            console.error("Error computing size on setup reset:", err);
        }
        if (node.size && !isNaN(node.size[1])) {
            node.size[1] = min_h;
        }
    }
    
    // Wrap onDrawForeground to render the note
    const origDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function(ctx, canvas) {
        try {
            // Automatically wrap computeSize of all widgets
            if (this.widgets) {
                for (let w of this.widgets) {
                    if (w && !wrappedWidgets.has(w)) {
                        wrapWidgetComputeSize(w, this);
                    }
                }
            }
        } catch (err) {
            console.error("Error in onDrawForeground widget wrapping:", err);
        }
        
        if (origDrawForeground) {
            try {
                origDrawForeground.apply(this, arguments);
            } catch (err) {
                console.error("Error in original onDrawForeground:", err);
            }
        }
        
        try {
            // Draw parameter notes
            if (this.widgets) {
                const canvasInstance = app.canvas;
                const width = this.size[0] || 200;
                
                for (let w of this.widgets) {
                    if (!w || !this.isWidgetVisible(w)) continue;
                    
                    const noteInfo = getWidgetNoteInfo(this, w);
                    const noteText = noteInfo.text;
                    const noteHeight = noteInfo.height;
                    
                    const w_normal_height = (w.computedHeight !== undefined)
                        ? Math.max(0, w.computedHeight - noteHeight)
                        : 20;
                    const y = getWidgetY(w) + w_normal_height;
                    
                    // Draw the note line/box
                    ctx.save();
                    
                    let isHovered = false;
                    let isResizeHovered = false;
                    if (canvasInstance && canvasInstance.graph_mouse && canvasInstance.node_over === this) {
                        const localX = canvasInstance.graph_mouse[0] - this.pos[0];
                        const localY = canvasInstance.graph_mouse[1] - this.pos[1];
                        
                        if (localX >= 8 && localX <= width - 8) {
                            if (noteHeight <= 4) {
                                if (localY >= y - 4 && localY <= y + noteHeight + 4) {
                                    isHovered = true;
                                    isResizeHovered = true;
                                }
                            } else {
                                if (localY >= y + noteHeight - 6 && localY <= y + noteHeight + 4) {
                                    isResizeHovered = true;
                                }
                            }
                        }
                    }
                    
                    if (noteHeight <= 4) {
                        // Collapsed state: draw a thin, subtle horizontal divider line
                        ctx.strokeStyle = isHovered ? "rgba(96, 165, 250, 0.75)" : "rgba(255, 255, 255, 0.08)";
                        ctx.lineWidth = isHovered ? 2 : 1;
                        ctx.beginPath();
                        ctx.moveTo(8, y + noteHeight / 2);
                        ctx.lineTo(width - 8, y + noteHeight / 2);
                        ctx.stroke();
                        
                        if (isResizeHovered && canvasInstance && canvasInstance.canvas) {
                            canvasInstance.canvas.style.cursor = "ns-resize";
                        }
                    } else {
                        // Expanded state: no box and no sidebar (borders)
                        
                        // Save context to scope the clipping region
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(8, y + 2, width - 16, noteHeight - 6);
                        ctx.clip();
                        
                        // Get scroll offset from virtual widget
                        const virtualWidget = getOrCreateVirtualNoteWidget(this, w);
                        if (virtualWidget._noteScrollY === undefined) {
                            virtualWidget._noteScrollY = 0;
                        }
                        
                        // Draw text or placeholder
                        const fontSize = virtualWidget.fontSize || 11;
                        ctx.font = `${fontSize}px Arial, sans-serif`;
                        ctx.textAlign = "left";
                        ctx.textBaseline = "top";
                        
                        const padding = 6;
                        const textX = 8 + padding;
                        const maxWidth = width - 16 - padding * 2;
                        const lineHeight = Math.round(fontSize * 1.27);
                        
                        // Clamp scroll offset to prevent out-of-bounds rendering
                        if (noteText) {
                            const textHeight = calculateTextHeight(ctx, noteText, maxWidth, lineHeight);
                            const noteAreaHeight = noteHeight - padding * 2;
                            const maxScrollY = Math.max(0, textHeight - noteAreaHeight);
                            if (virtualWidget._noteScrollY > maxScrollY) {
                                virtualWidget._noteScrollY = maxScrollY;
                            }
                        }
                        
                        const scrollY = virtualWidget._noteScrollY || 0;
                        const textY = y + padding - scrollY;
                        
                        if (noteText) {
                            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
                            drawWrappedText(ctx, noteText, textX, textY, maxWidth, lineHeight);
                        } else {
                            ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
                            ctx.fillText("[双击添加注释...]", textX, textY);
                        }
                        
                        // Restore context to remove clipping path
                        ctx.restore();
                        
                        // Draw a subtle resize handle at the bottom edge (only on hover or very subtly)
                        ctx.strokeStyle = isResizeHovered ? "rgba(96, 165, 250, 0.8)" : "rgba(255, 255, 255, 0.15)";
                        ctx.lineWidth = isResizeHovered ? 2 : 1;
                        ctx.beginPath();
                        ctx.moveTo(width / 2 - (isResizeHovered ? 12 : 8), y + noteHeight - 2);
                        ctx.lineTo(width / 2 + (isResizeHovered ? 12 : 8), y + noteHeight - 2);
                        ctx.stroke();
                        
                        // Handle cursor type setting
                        if (canvasInstance && canvasInstance.canvas && canvasInstance.node_over === this && canvasInstance.graph_mouse) {
                            if (isResizeHovered) {
                                canvasInstance.canvas.style.cursor = "ns-resize";
                            } else {
                                // Check if hovering over the note text area (excluding bottom handle)
                                const localX = canvasInstance.graph_mouse[0] - this.pos[0];
                                const localY = canvasInstance.graph_mouse[1] - this.pos[1];
                                if (localX >= 8 && localX <= width - 8 && localY >= y && localY < y + noteHeight - 6) {
                                    canvasInstance.canvas.style.cursor = "pointer";
                                }
                            }
                        }
                    }
                    ctx.restore();
                }
            }
        } catch (err) {
            console.error("Error in onDrawForeground parameter notes drawing:", err);
        }
        
    };
    
    // Wrap onDblClick to edit the note
    const origDblClick = node.onDblClick;
    node.onDblClick = function(e, pos, canvasInstance) {
        try {
            const localX = pos[0];
            const localY = pos[1];
            const width = this.size[0] || 200;
            
            // First check if they double-clicked inside any parameter notes area
            // We use a generous vertical hit range of 15px around the divider line
            if (this.widgets && localX >= 8 && localX <= width - 8) {
                for (let w of this.widgets) {
                    if (!w || !this.isWidgetVisible(w)) continue;
                    
                    const noteInfo = getWidgetNoteInfo(this, w);
                    const noteHeight = noteInfo.height;
                    const effectiveNoteH = getEffectiveNoteHeight(w, noteHeight);
                    
                    const w_normal_height = (w.computedHeight !== undefined)
                        ? Math.max(0, w.computedHeight - effectiveNoteH)
                        : 20;
                    const widgetY = getWidgetY(w) + w_normal_height;
                    const widgetMaxY = widgetY + effectiveNoteH;
                    
                    let isDblClickHit = false;
                    if (effectiveNoteH <= 4) {
                        // Collapsed: generous 16px hit area around the thin line
                        if (localY >= widgetY - 8 && localY <= widgetMaxY + 8) {
                            isDblClickHit = true;
                        }
                    } else {
                        // Expanded: anywhere inside the note box
                        if (localY >= widgetY && localY <= widgetMaxY + 4) {
                            isDblClickHit = true;
                        }
                    }
                    
                    if (isDblClickHit) {
                        const virtualWidget = getOrCreateVirtualNoteWidget(this, w);
                        openParameterNoteEditor(this, virtualWidget);
                        this.__noteEditorOpened = true; // Mark as handled
                        return true;
                    }
                }
            }
            
        } catch (err) {
            console.error("Error in node.onDblClick override:", err);
        }
        
        if (origDblClick) {
            return origDblClick.apply(this, arguments);
        }
    };
}

// Hook helpers will be dynamically registered during setup to avoid race conditions and guarantee LiteGraph is loaded

// Register frontend extension
app.registerExtension({
    name: "Comfy.NodeNotes",
    
    // Setup is called after the application has fully loaded
    setup(appInstance) {
        const canvasInstance = appInstance.canvas || app.canvas;
        const canvasEl = canvasInstance && canvasInstance.canvas;
        if (!canvasEl) return;

        // 1. Hook getWidgetOnPos to intercept widget hit-testing
        const LGraphNodeClass = window.LGraphNode || (window.LiteGraph && window.LiteGraph.LGraphNode);
        if (LGraphNodeClass && !LGraphNodeClass.prototype._notes_getWidgetOnPos_wrapped) {
            LGraphNodeClass.prototype._notes_getWidgetOnPos_wrapped = true;
            const origGetWidgetOnPos = LGraphNodeClass.prototype.getWidgetOnPos;
            LGraphNodeClass.prototype.getWidgetOnPos = function(canvasX, canvasY, includeDisabled) {
                try {
                    if (!this.widgets || this.widgets.length === 0) {
                        return origGetWidgetOnPos ? origGetWidgetOnPos.apply(this, arguments) : undefined;
                    }
                    
                    const pos = this.pos || [0, 0];
                    const localX = canvasX - pos[0];
                    const localY = canvasY - pos[1];
                    const width = this.size[0] || 200;
                    
                    // Check if the coordinate is within the horizontal bounds of widgets
                    if (localX >= 8 && localX <= width - 8) {
                        for (let w of this.widgets) {
                            if (!w || !this.isWidgetVisible(w)) continue;
                            
                            const noteInfo = getWidgetNoteInfo(this, w);
                            const noteHeight = noteInfo.height;
                            const effectiveNoteH = getEffectiveNoteHeight(w, noteHeight);
                            
                            const w_normal_height = (w.computedHeight !== undefined)
                                ? Math.max(0, w.computedHeight - effectiveNoteH)
                                : 20;
                            const widgetY = getWidgetY(w) + w_normal_height;
                            const widgetMaxY = widgetY + effectiveNoteH;
                            
                            let isHit = false;
                            if (effectiveNoteH <= 4) {
                                if (localY >= widgetY - 4 && localY <= widgetMaxY + 4) {
                                    isHit = true;
                                }
                            } else {
                                // Check if hovering near the bottom resize edge (last 6px)
                                if (localY >= widgetMaxY - 6 && localY <= widgetMaxY + 4) {
                                    isHit = true;
                                }
                            }
                            
                            if (isHit) {
                                return getOrCreateVirtualNoteWidget(this, w);
                            }
                            
                            // Click / selection edit bounds inside parameter note text area
                            // (effectiveNoteH covers leaked note height from inner widgets in Group Nodes)
                            if (effectiveNoteH > 4 && localY >= widgetY && localY < widgetMaxY - 6) {
                                return getOrCreateVirtualNoteWidget(this, w);
                            }
                        }
                    }
                } catch (err) {
                    console.error("Error in getWidgetOnPos override:", err);
                }
                
                if (origGetWidgetOnPos) {
                    return origGetWidgetOnPos.apply(this, arguments);
                }
            };
        }

        // Hook LGraphNode.prototype.onAdded to automatically setup notes on nodes inside subgraphs
        if (LGraphNodeClass && !LGraphNodeClass.prototype._notes_onAdded_wrapped) {
            LGraphNodeClass.prototype._notes_onAdded_wrapped = true;
            const origOnAdded = LGraphNodeClass.prototype.onAdded;
            LGraphNodeClass.prototype.onAdded = function(graph) {
                try {
                    if (!isExcludedNode(this)) {
                        setupNodeNotes(this, canvasInstance);
                        wrapAllNodeWidgets(this);
                    }
                } catch (err) {
                    console.error("Error in LGraphNode.prototype.onAdded hook:", err);
                }
                if (origOnAdded) {
                    return origOnAdded.apply(this, arguments);
                }
            };
        }

        // 2. Hook LGraphCanvas methods
        const LGraphCanvasClass = window.LGraphCanvas || (window.LiteGraph && window.LiteGraph.LGraphCanvas);
        if (LGraphCanvasClass) {
            // Intercept openSubgraph to prevent entering subgraphs when clicking notes area
            if (!LGraphCanvasClass.prototype._notes_openSubgraph_wrapped) {
                LGraphCanvasClass.prototype._notes_openSubgraph_wrapped = true;
                const origOpenSubgraph = LGraphCanvasClass.prototype.openSubgraph;
                LGraphCanvasClass.prototype.openSubgraph = function(subgraph, node) {
                    try {
                        if (node) {
                            if (node.__noteEditorOpened) {
                                delete node.__noteEditorOpened;
                                return; // Do not open subgraph
                            }
                        }
                    } catch (err) {
                        console.error("Error in openSubgraph override:", err);
                    }
                    if (origOpenSubgraph) {
                        return origOpenSubgraph.apply(this, arguments);
                    }
                };
            }

            // Intercept processNodeDblClicked to prevent default canvas double click actions on nodes
            if (!LGraphCanvasClass.prototype._notes_processNodeDblClicked_wrapped) {
                LGraphCanvasClass.prototype._notes_processNodeDblClicked_wrapped = true;
                const origProcessNodeDblClicked = LGraphCanvasClass.prototype.processNodeDblClicked;
                LGraphCanvasClass.prototype.processNodeDblClicked = function(node) {
                    try {
                        if (node && node.__noteEditorOpened) {
                            if (node.type === "graph/subgraph") {
                                return; // Intercepted double click, stop processing default action (openSubgraph will clean the flag)
                            }
                            delete node.__noteEditorOpened;
                            return; // Intercepted double click, stop processing default action
                        }
                    } catch (err) {
                        console.error("Error in processNodeDblClicked override:", err);
                    }
                    if (origProcessNodeDblClicked) {
                        return origProcessNodeDblClicked.apply(this, arguments);
                    }
                };
            }

            // Intercept processWidgetClick to safely release node_widget lock
            if (!LGraphCanvasClass.prototype._notes_processWidgetClick_wrapped) {
                LGraphCanvasClass.prototype._notes_processWidgetClick_wrapped = true;
                const origProcessWidgetClick = LGraphCanvasClass.prototype.processWidgetClick;
                LGraphCanvasClass.prototype.processWidgetClick = function(event, node, widget, pointer) {
                    const canvasInstance = this;
                    const p = pointer || this.pointer;
                    const res = origProcessWidgetClick ? origProcessWidgetClick.apply(this, arguments) : undefined;
                    
                    if (widget && widget.type === "parameter_note") {
                        const origFinally = p.finally;
                        if (origFinally) {
                            p.finally = () => {
                                try {
                                    origFinally();
                                } catch (err) {
                                    console.error("Error in original finally:", err);
                                } finally {
                                    canvasInstance.node_widget = null;
                                }
                            };
                        }
                    }
                    return res;
                };
            }
        }
        
        // Attach capture-phase wheel listener to successfully intercept and block LiteGraph zoom handler
        canvasEl.addEventListener("wheel", (e) => {
            try {
                const scale = canvasInstance.ds.scale;
                const offset = canvasInstance.ds.offset;
                const boundingRect = canvasEl.getBoundingClientRect();
                
                // Convert viewport coordinates to canvas local coordinates
                const canvasX = (e.clientX - boundingRect.left) / scale - offset[0];
                const canvasY = (e.clientY - boundingRect.top) / scale - offset[1];
                
                const graph = canvasInstance.graph || app.graph;
                if (!graph) return;
                
                const node = graph.getNodeOnPos ? graph.getNodeOnPos(canvasX, canvasY) : 
                             (canvasInstance.getNodeOnPos ? canvasInstance.getNodeOnPos(canvasX, canvasY) : null);
                
                if (node) {
                    const localY = canvasY - node.pos[1];
                    const localX = canvasX - node.pos[0];
                    const width = node.size[0] || 200;
                    
                    // Check if the scroll event is over any parameter note box
                    let isInsideParameterNote = false;
                    let targetNoteWidget = null;
                    if (node.widgets) {
                        for (let w of node.widgets) {
                            if (!w) continue;
                            const noteInfo = getWidgetNoteInfo(node, w);
                            const noteHeight = noteInfo.height;
                            if (noteHeight > 4) {
                                const w_normal_height = (w.computedHeight !== undefined)
                                    ? Math.max(0, w.computedHeight - noteHeight)
                                    : 20;
                                const y = getWidgetY(w) + w_normal_height;
                                if (localX >= 8 && localX <= width - 8 && localY >= y && localY <= y + noteHeight) {
                                    isInsideParameterNote = true;
                                    targetNoteWidget = getOrCreateVirtualNoteWidget(node, w);
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (isInsideParameterNote && targetNoteWidget) {
                        // Always intercept and block canvas zoom/scroll when mouse is inside the notes area
                        e.preventDefault();
                        e.stopPropagation();
                        
                        if (e.ctrlKey) {
                            // Ctrl + wheel -> Adjust parameter note font size
                            let currentSize = targetNoteWidget.fontSize || 11;
                            const delta = e.deltaY < 0 ? 1 : -1;
                            currentSize = Math.max(8, Math.min(24, currentSize + delta));
                            targetNoteWidget.fontSize = currentSize;
                            canvasInstance.draw(true, true);
                        } else {
                            // Wheel only -> Scroll parameter note text
                            const noteInfo = getWidgetNoteInfo(node, node.widgets.find(w => w && w.name === targetNoteWidget.targetWidgetName));
                            const noteHeight = noteInfo.height;
                            const padding = 6;
                            const noteAreaHeight = noteHeight - padding * 2;
                            
                            const noteText = targetNoteWidget.value || "";
                            if (noteText) {
                                const ctx = canvasEl.getContext("2d");
                                ctx.save();
                                const fontSize = targetNoteWidget.fontSize || 11;
                                const lineHeight = Math.round(fontSize * 1.27);
                                ctx.font = `${fontSize}px Arial, sans-serif`;
                                const textHeight = calculateTextHeight(ctx, noteText, width - 16 - padding * 2, lineHeight);
                                ctx.restore();
                                
                                if (textHeight > noteAreaHeight) {
                                    const maxScrollY = textHeight - noteAreaHeight;
                                    if (targetNoteWidget._noteScrollY === undefined) {
                                        targetNoteWidget._noteScrollY = 0;
                                    }
                                    
                                    targetNoteWidget._noteScrollY += e.deltaY * 0.15;
                                    targetNoteWidget._noteScrollY = Math.max(0, Math.min(targetNoteWidget._noteScrollY, maxScrollY));
                                    
                                    // Redraw canvas
                                    canvasInstance.draw(true, true);
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error in wheel event listener:", err);
            }
        }, { capture: true, passive: false });
    },
    
    // Triggers when a node is created in the current session
    nodeCreated(node, appInstance) {
        if (isExcludedNode(node)) return;
        setupNodeNotes(node, appInstance.canvas || app.canvas);
        wrapAllNodeWidgets(node);
    },
    
    // Triggers when a node is loaded from a saved workflow
    loadedGraphNode(node, appInstance) {
        if (isExcludedNode(node)) return;
        setupNodeNotes(node, appInstance.canvas || app.canvas);
        wrapAllNodeWidgets(node);
    },
    
    // Add right-click context menu options
    getNodeMenuItems(node) {
        return [
            {
                content: "重置参数注释与高度 (Reset Parameter Notes)",
                callback: () => {
                    if (node.properties) {
                        node.properties.parameterNotes = {};
                    }
                    
                    let min_h = 50;
                    try {
                        if (node.computeSize) {
                            const sz = node.computeSize();
                            if (sz && !isNaN(sz[1])) {
                                min_h = sz[1];
                            }
                        }
                    } catch (err) {
                        console.error("Error computing size on reset:", err);
                    }
                    if (node.size) {
                        node.size[1] = min_h;
                    }
                    app.canvas.draw(true, true);
                }
            }
        ];
    }
});
