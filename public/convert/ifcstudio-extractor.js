/*
 * IFC Studio — model extractor for the Autodesk viewer (LMV 7).
 *
 * Reads the geometry, model tree and properties of the model(s) open in an
 * Autodesk viewer page and hands them to IFC Studio's Convert page, which
 * writes IFC files from them. Two ways in:
 *
 *   - As a bookmarklet on a viewer page (viewer.autodesk.com, ACC, any page
 *     running the Autodesk viewer): shows a small panel to pick the source
 *     files, then sends the result to the IFC Studio window that opened the
 *     page, or downloads it as one .eapk file to drop on the Convert page.
 *   - Inside IFC Studio, on a model it opened through Autodesk Platform
 *     Services: IFCStudioExtractor.extract(viewer, options).
 *
 * Only reads what the viewer already shows; nothing is sent anywhere except
 * to the IFC Studio window (window.opener) or a local download. Use it on
 * models you are entitled to export.
 *
 * Output (format 3), per source file in the model:
 *   ifcstudio-<job>.bin        "EANWD1" + u32 header length + header JSON + aligned sections: node table,
 *                              fragments, shapes (positions, triangles or lines, texture coordinates,
 *                              vertex colours); the header lists the materials (colour, opacity,
 *                              specular, shininess, metal, transparency, texture and its transform)
 *   ifcstudio-<job>-props.json { format: 3, mode, job, strings, numbers, units, rows: [[dbId, k, v, k, v, ...]] }
 *                              (v >= 0: strings[v]; v < 0: numbers[-v - 1])
 *   ifcstudio-<job>-tex<n>.png the texture images, as the viewer decoded them
 * Bundle (.eapk): "EAPK1" + per file [u32 name length, f64 size, name, bytes].
 */
(function (global) {
  "use strict";

  var VERSION = 3;
  // Node types that are tree levels, not elements: assembly, layer, collection, model.
  var GROUP = { 0: 1, 2: 1, 3: 1, 5: 1 };
  var NODE_MODEL = 5;
  // Everything the viewer holds is read; what goes into the IFC is chosen on the Convert page.
  var SKIP = null;
  var KEY_PROPS = ["Category", "Family", "Type", "Id", "Level", "GUID", "System Type", "System Name", "System Classification", "Size", "Overall Size", "Diameter", "Outside Diameter", "Length", "Width", "Height", "Mark", "Comments", "Type Mark", "Manufacturer", "Model", "Description", "Workset", "Room", "Flow", "Free Size", "Family Name", "Type Name", "Base Constraint", "Reference Level", "Schedule Level", "Element ID", "IfcGUID", "Family and Type"];
  var INTERNAL = /^__(parent|child|viewable_in|internalref|node_flags|instanceof|name|document)__$/;

  function sleep() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function slug(text) {
    return String(text || "model")
      .replace(/\.(nwc|nwd|nwf|rvt|ifc|dwg)$/i, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "model";
  }

  // ---------------------------------------------------------------------------
  // Viewer access

  function findViewer() {
    if (global.NOP_VIEWER && global.NOP_VIEWER.model) return global.NOP_VIEWER;
    return null;
  }

  function modelsOf(viewer) {
    var list = viewer.getAllModels ? viewer.getAllModels() : viewer.impl && viewer.impl.modelQueue ? viewer.impl.modelQueue().getModels() : [viewer.model];
    return (list || []).filter(function (m) {
      return m && m.getInstanceTree && m.getInstanceTree() && m.getFragmentList && m.getFragmentList();
    });
  }

  /**
   * Some viewer pages (viewer.autodesk.com) store files under a generated name
   * ("t1793798762_96812450-….nwd") and show the real one only in the page; use
   * that when the model's own name is a generated one.
   */
  function friendlyName(name) {
    if (!/^t\d+_[0-9a-f]{8}-|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(name)) return name;
    var ext = /\.([a-z0-9]+)$/i.exec(name);
    var re = ext ? new RegExp("\\." + ext[1] + "$", "i") : /\.(nwd|nwc|rvt|ifc|dwg)$/i;
    var els = document.querySelectorAll("[title],[aria-label]");
    for (var i = 0; i < els.length; i++) {
      var s = (els[i].getAttribute("title") || els[i].getAttribute("aria-label") || "").trim();
      if (s.length < 200 && re.test(s) && !/^t\d+_[0-9a-f]{8}-/i.test(s)) return s;
    }
    return name;
  }

  function modelName(model) {
    try {
      var node = model.getDocumentNode && model.getDocumentNode();
      var root = node && node.getRootNode && node.getRootNode();
      var name = root && root.children && root.children[0] && root.children[0].data && root.children[0].data.name;
      if (name) return friendlyName(String(name));
      if (node && node.data && node.data.name) return friendlyName(String(node.data.name));
    } catch (e) {
      /* fall through */
    }
    var data = model.getData ? model.getData() : null;
    if (data && data.loadOptions && data.loadOptions.modelNameOverride) return String(data.loadOptions.modelNameOverride);
    var tree = model.getInstanceTree();
    return friendlyName(tree.getNodeName(tree.getRootId()) || "") || document.title || "Model";
  }

  function unitScale(model) {
    try {
      if (model.getUnitScale) {
        var s = model.getUnitScale();
        if (s > 0) return s;
      }
    } catch (e) {
      /* fall through */
    }
    var unit = model.getUnitString ? String(model.getUnitString() || "") : "";
    var table = { ft: 0.3048, in: 0.0254, m: 1, cm: 0.01, mm: 0.001, km: 1000, yd: 0.9144, mi: 1609.344 };
    return table[unit] || 0.3048;
  }

  function newMatrix() {
    if (global.THREE && global.THREE.Matrix4) return new global.THREE.Matrix4();
    var P = global.Autodesk && global.Autodesk.Viewing && global.Autodesk.Viewing.Private;
    if (P && P.LmvMatrix4) return new P.LmvMatrix4(true);
    throw new Error("The viewer's math library is not available on this page.");
  }

  function newBox() {
    if (global.THREE && global.THREE.Box3) return new global.THREE.Box3();
    var P = global.Autodesk && global.Autodesk.Viewing && global.Autodesk.Viewing.Private;
    if (P && P.LmvBox3) return new P.LmvBox3();
    throw new Error("The viewer's math library is not available on this page.");
  }

  function treeOf(model) {
    var it = model.getInstanceTree();
    var na = it.nodeAccess;
    return {
      it: it,
      type: function (id) {
        return na.getNodeFlags(id) & 7;
      },
      name: function (id) {
        return it.getNodeName(id) || "";
      },
      kids: function (id) {
        var out = [];
        it.enumNodeChildren(
          id,
          function (c) {
            out.push(c);
          },
          false,
        );
        return out;
      },
      ownsFragments: function (id) {
        var found = false;
        it.enumNodeFragments(
          id,
          function () {
            found = true;
            return true;
          },
          false,
        );
        return found;
      },
    };
  }

  /** The source files of a model: the top-most "model" nodes (NWC / RVT files in a federated NWD), else the root. */
  function fileRoots(model) {
    var t = treeOf(model);
    var root = t.it.getRootId();
    var out = [];
    var queue = t.kids(root).map(function (id) {
      return [id, 1];
    });
    while (queue.length) {
      var item = queue.shift();
      var id = item[0];
      if (t.type(id) === NODE_MODEL) out.push(id);
      else if (item[1] < 6)
        t.kids(id).forEach(function (c) {
          queue.push([c, item[1] + 1]);
        });
    }
    return out.length ? out : [root];
  }

  function countFragments(model, id) {
    var n = 0;
    model.getInstanceTree().enumNodeFragments(
      id,
      function () {
        n++;
      },
      true,
    );
    return n;
  }

  // ---------------------------------------------------------------------------
  // Geometry and tree

  function Pool(T) {
    this.T = T;
    this.a = new T(4096);
    this.n = 0;
  }
  Pool.prototype.grow = function (k) {
    if (this.n + k <= this.a.length) return;
    var L = this.a.length;
    while (L < this.n + k) L *= 2;
    var b = new this.T(L);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  };
  Pool.prototype.push1 = function (v) {
    this.grow(1);
    this.a[this.n++] = v;
  };
  Pool.prototype.pushArr = function (arr) {
    this.grow(arr.length);
    this.a.set(arr, this.n);
    this.n += arr.length;
  };
  Pool.prototype.get = function () {
    return this.a.subarray(0, this.n);
  };

  var SECTIONS = [
    ["ndb", Uint32Array],
    ["npar", Uint32Array],
    ["nname", Uint32Array],
    ["ntyp", Uint8Array],
    ["fdb", Uint32Array],
    ["fgeom", Uint32Array],
    ["fmat", Uint32Array],
    ["fmtx", Float32Array],
    ["fbox", Float32Array],
    ["gmeta", Uint32Array],
    ["posQ", Uint16Array],
    ["posF", Float32Array],
    ["i16", Uint16Array],
    ["i32", Uint32Array],
    ["uv", Float32Array],
    ["col", Uint8Array],
  ];
  // Per unique geometry: nv, ni, flags, position offset, index offset, uv offset, colour offset.
  var GMETA = 7;
  var NONE = 0xffffffff;
  var FLAG_QUANTIZED = 1,
    FLAG_INDEX32 = 2,
    FLAG_NON_INDEXED = 4,
    FLAG_LINES = 8;

  function halfToFloat(h) {
    var s = (h & 0x8000) >> 15,
      e = (h & 0x7c00) >> 10,
      f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  /** Reads `comps` components of attribute `a` of an interleaved viewer geometry into floats. */
  function readAttribute(g, a, nv, comps) {
    var out = new Float32Array(nv * comps);
    var stride = g.vbstride;
    var bytes = a.bytesPerItem || 4;
    var off = a.itemOffset || 0;
    if (bytes === 4) {
      for (var i = 0; i < nv; i++) for (var k = 0; k < comps; k++) out[i * comps + k] = g.vb[i * stride + off + k];
    } else if (bytes === 2) {
      var u = new Uint16Array(g.vb.buffer, g.vb.byteOffset, g.vb.length * 2);
      for (var j = 0; j < nv; j++)
        for (var c = 0; c < comps; c++) {
          var raw = u[j * stride * 2 + off * 2 + c];
          out[j * comps + c] = a.normalized ? raw / 65535 : halfToFloat(raw);
        }
    } else {
      var b = new Uint8Array(g.vb.buffer, g.vb.byteOffset, g.vb.length * 4);
      for (var q = 0; q < nv; q++) for (var d = 0; d < comps; d++) out[q * comps + d] = b[q * stride * 4 + off * 4 + d] / (a.normalized === false ? 1 : 255);
    }
    return out;
  }

  function hexOf(color) {
    return color && color.getHexString ? color.getHexString() : null;
  }

  async function extractGeometry(model, root, jobName, onProgress) {
    var t = treeOf(model);
    var it = t.it;
    var fl = model.getFragmentList();
    var P = {};
    SECTIONS.forEach(function (s) {
      P[s[0]] = new Pool(s[1]);
    });
    var strings = [];
    var sIdx = new Map();
    function sidx(s) {
      var k = sIdx.get(s);
      if (k === undefined) {
        k = strings.length;
        strings.push(s);
        sIdx.set(s, k);
      }
      return k;
    }
    var gmap = new Map();
    var mats = new Map();
    var matList = [];
    var matRecords = [];
    var textures = [];
    var textureIndex = new Map();
    var M4 = newMatrix();
    var B3 = newBox();
    var st = { skippedNodes: 0, lineFrags: 0, pointFrags: 0, missingGeometry: 0, nonIndexed: 0, withUV: 0, withColours: 0, textures: 0, texturesUnreadable: 0 };

    function addGeom(g) {
      var a = g.attributes && g.attributes.position;
      if (!a || !g.vb) return -1;
      var s = g.vbstride;
      var nv = Math.floor(g.vb.length / s);
      var off = a.itemOffset || 0;
      var flags = g.isLines || g.isWideLines ? FLAG_LINES : 0;
      var pOff, ni;
      var iOff = 0;
      if (a.bytesPerItem === 2) {
        flags |= FLAG_QUANTIZED;
        var u = new Uint16Array(g.vb.buffer, g.vb.byteOffset, g.vb.length * 2);
        var s2 = s * 2,
          o2 = off * 2;
        var tq = new Uint16Array(nv * 3);
        for (var i = 0; i < nv; i++) {
          var b = i * s2 + o2;
          tq[3 * i] = u[b];
          tq[3 * i + 1] = u[b + 1];
          tq[3 * i + 2] = u[b + 2];
        }
        pOff = P.posQ.n / 3;
        P.posQ.pushArr(tq);
      } else {
        var tf = new Float32Array(nv * 3);
        for (var j = 0; j < nv; j++) {
          var c = j * s + off;
          tf[3 * j] = g.vb[c];
          tf[3 * j + 1] = g.vb[c + 1];
          tf[3 * j + 2] = g.vb[c + 2];
        }
        pOff = P.posF.n / 3;
        P.posF.pushArr(tf);
      }
      var ib = g.ib || g.indices;
      if (ib && ib.length) {
        ni = ib.length;
        if (nv > 65535 || ib instanceof Uint32Array) {
          flags |= FLAG_INDEX32;
          iOff = P.i32.n;
          P.i32.pushArr(ib);
        } else {
          iOff = P.i16.n;
          P.i16.pushArr(ib);
        }
      } else {
        flags |= FLAG_NON_INDEXED;
        ni = nv;
        st.nonIndexed++;
      }
      // Texture coordinates and vertex colours, when the shape has them.
      var uvOff = NONE,
        colOff = NONE;
      var uvA = g.attributes.uv;
      if (uvA && !(flags & FLAG_LINES)) {
        uvOff = P.uv.n / 2;
        P.uv.pushArr(readAttribute(g, uvA, nv, 2));
        st.withUV++;
      }
      var colA = g.attributes.color;
      if (colA) {
        var cf = readAttribute(g, colA, nv, 3);
        var cb = new Uint8Array(nv * 3);
        for (var q = 0; q < cf.length; q++) cb[q] = Math.max(0, Math.min(255, Math.round(cf[q] * 255)));
        colOff = P.col.n / 3;
        P.col.pushArr(cb);
        st.withColours++;
      }
      P.gmeta.pushArr([nv, ni, flags, pOff, iOff, uvOff, colOff]);
      return P.gmeta.n / GMETA - 1;
    }

    // The texture image as the viewer decoded it (drawn to a canvas, saved as PNG), with its
    // average colour for viewers that show no textures.
    function noteTexture(tex) {
      if (!tex || !tex.image) return -1;
      // An inverted map is saved inverted (IFC has no such switch).
      var key = (tex.image.src || tex.uuid || "") + (tex.invert ? "|inverted" : "");
      if (!key) key = tex;
      if (textureIndex.has(key)) return textureIndex.get(key);
      var index = textures.length;
      textureIndex.set(key, index);
      var src = String((tex.image && tex.image.src) || "");
      var named = tex.sourceFile || tex.name || (/^data:/.test(src) ? "" : src.split("?")[0]);
      textures.push({ tex: tex, name: String(named || "").split(/[\\/]/).pop() });
      return index;
    }

    function textureOf(mt) {
      if (mt.map) return mt.map;
      var keys = ["opaque_albedo_map", "metal_f0_map", "layered_diffuse_map", "surface_albedo_map", "transparent_color_map", "wood_curly_distortion_map"];
      for (var i = 0; i < keys.length; i++) if (mt[keys[i]] && mt[keys[i]].image) return mt[keys[i]];
      return null;
    }

    // The material's own name, where the viewer kept its Autodesk material definition.
    function proteinName(mt) {
      var p = mt.proteinMat;
      if (typeof p === "string") {
        try {
          p = JSON.parse(p);
        } catch (e) {
          p = null;
        }
      }
      if (!p || !p.materials) return "";
      for (var k in p.materials) {
        var x = p.materials[k];
        if (!x) continue;
        if (x.name) return String(x.name);
        var strings = x.properties && x.properties.strings;
        if (strings) {
          var keys = ["UIName", "name", "Name", "common_name", "AssetName"];
          for (var i = 0; i < keys.length; i++) {
            var v = strings[keys[i]];
            var value = v && (v.values ? v.values[0] : v);
            if (typeof value === "string" && value) return value;
          }
        }
      }
      return "";
    }

    function materialRecord(mt) {
      var r = { c: hexOf(mt && mt.color) || "8c8c8c", o: mt && mt.opacity !== undefined ? +(+mt.opacity).toFixed(3) : 1 };
      if (!mt) return r;
      var name = mt.name || proteinName(mt);
      if (name) r.n = String(name);
      if (mt.transparent) r.t = 1;
      if (mt.type === "LineBasicMaterial" || mt.isLineMaterial) r.l = 1;
      if (mt.isPrismMaterial) {
        // Autodesk's physically based materials: pick the colour the viewer shades with.
        var kind = String(mt.prism_type || "");
        r.p = kind;
        var pc = /Metal/.test(kind) ? mt.metal_f0 : /Transparent|Glazing/.test(kind) ? mt.transparent_color : /Layered/.test(kind) ? mt.layered_diffuse : /Wood/.test(kind) ? mt.wood_early_color : mt.opaque_albedo || mt.surface_albedo;
        if (hexOf(pc)) r.c = hexOf(pc);
        if (/Metal/.test(kind)) r.m = 1;
        if (/Transparent|Glazing/.test(kind) && r.o >= 1) r.o = 0.3;
        if (typeof mt.surface_roughness === "number") r.ro = +mt.surface_roughness.toFixed(3);
      } else {
        if (hexOf(mt.specular)) r.s = hexOf(mt.specular);
        if (typeof mt.shininess === "number") r.sh = +mt.shininess.toFixed(2);
        if (typeof mt.reflectivity === "number") r.r = +mt.reflectivity.toFixed(3);
        if (mt.metal) r.m = 1;
        if (hexOf(mt.emissive) && hexOf(mt.emissive) !== "000000") r.e = hexOf(mt.emissive);
      }
      if (mt.vertexColors) r.vc = 1;
      var tex = textureOf(mt);
      var ti = noteTexture(tex);
      if (ti >= 0) {
        r.tex = ti;
        r.tm = tex.matrix && tex.matrix.elements ? Array.prototype.map.call(tex.matrix.elements, function (v) {
          return +(+v).toPrecision(9);
        }) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        if (tex.repeat && (tex.repeat.x !== 1 || tex.repeat.y !== 1)) r.rp = [tex.repeat.x, tex.repeat.y];
        if (tex.offset && (tex.offset.x || tex.offset.y)) r.of = [tex.offset.x, tex.offset.y];
        r.ws = tex.clampS || tex.wrapS === 1001 ? 0 : 1;
        r.wt = tex.clampT || tex.wrapT === 1001 ? 0 : 1;
      }
      return r;
    }

    var stack = [root, it.getNodeParentId(root)];
    var visited = 0;
    while (stack.length) {
      var par = stack.pop();
      var id = stack.pop();
      var nm = t.name(id);
      if (id !== root && SKIP && SKIP.test(nm)) {
        st.skippedNodes++;
        continue;
      }
      P.ndb.push1(id);
      P.npar.push1(par);
      P.nname.push1(sidx(nm));
      P.ntyp.push1(t.type(id));
      it.enumNodeChildren(
        id,
        function (c) {
          stack.push(c, id);
        },
        false,
      );
      it.enumNodeFragments(
        id,
        function (f) {
          var vm = fl.getVizmesh(f);
          var g = vm && vm.geometry;
          if (!g) {
            st.missingGeometry++;
            return;
          }
          if (g.isPoints) {
            st.pointFrags++;
            return;
          }
          if (g.isLines || g.isWideLines) st.lineFrags++;
          var gid = fl.getGeometryId(f);
          var gi = gmap.get(gid);
          if (gi === undefined) {
            gi = addGeom(g);
            gmap.set(gid, gi);
          }
          if (gi < 0) {
            st.missingGeometry++;
            return;
          }
          var mid = fl.getMaterialId(f);
          var mi = mats.get(mid);
          if (mi === undefined) {
            var mt = fl.getMaterial(f);
            var rec = materialRecord(mt);
            mi = matList.length;
            mats.set(mid, mi);
            matList.push([rec.c, rec.o]);
            matRecords.push(rec);
          }
          fl.getWorldMatrix(f, M4);
          var e = M4.elements;
          P.fmtx.pushArr([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]]);
          fl.getWorldBounds(f, B3);
          P.fbox.pushArr([B3.min.x, B3.min.y, B3.min.z, B3.max.x, B3.max.y, B3.max.z]);
          P.fdb.push1(id);
          P.fgeom.push1(gi);
          P.fmat.push1(mi);
        },
        false,
      );
      if (++visited % 20000 === 0) {
        if (onProgress) onProgress("geometry", P.fdb.n);
        await sleep();
      }
    }

    // Texture images: decoded pixels, saved as PNG.
    var textureFiles = [];
    var textureMeta = [];
    for (var ti2 = 0; ti2 < textures.length; ti2++) {
      var entry = textures[ti2];
      var img = entry.tex.image;
      var file = null,
        avg = null;
      try {
        var w = img.naturalWidth || img.width || 0;
        var h = img.naturalHeight || img.height || 0;
        if (!(w > 0 && h > 0)) throw new Error("empty image");
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        // Saved the way texture coordinates read it: (0, 0) at the bottom left, as with flipY (the
        // viewer's default for pictures). A texture uploaded without flipY has its first row at v = 0,
        // so it is turned over.
        var turn = entry.tex.flipY === false;
        if (img.data && typeof img.data.length === "number") {
          var px = new Uint8ClampedArray(w * h * 4);
          var pixels = img.data;
          var channels = Math.max(1, Math.round(pixels.length / (w * h)));
          var scale = pixels instanceof Float32Array || pixels instanceof Float64Array ? 255 : 1;
          for (var y = 0; y < h; y++) {
            var row = turn ? h - 1 - y : y;
            for (var x = 0; x < w; x++) {
              var si = (row * w + x) * channels;
              var di = (y * w + x) * 4;
              px[di] = pixels[si] * scale;
              px[di + 1] = pixels[si + (channels > 1 ? 1 : 0)] * scale;
              px[di + 2] = pixels[si + (channels > 2 ? 2 : 0)] * scale;
              px[di + 3] = channels > 3 ? pixels[si + 3] * scale : 255;
            }
          }
          ctx.putImageData(new ImageData(px, w, h), 0, 0);
        } else {
          if (turn) {
            ctx.translate(0, h);
            ctx.scale(1, -1);
          }
          ctx.drawImage(img, 0, 0, w, h);
        }
        if (entry.tex.invert) {
          var inv = ctx.getImageData(0, 0, w, h);
          for (var q2 = 0; q2 < inv.data.length; q2 += 4) {
            inv.data[q2] = 255 - inv.data[q2];
            inv.data[q2 + 1] = 255 - inv.data[q2 + 1];
            inv.data[q2 + 2] = 255 - inv.data[q2 + 2];
          }
          ctx.putImageData(inv, 0, 0);
        }
        var small = document.createElement("canvas");
        small.width = small.height = 8;
        var sctx = small.getContext("2d");
        sctx.drawImage(canvas, 0, 0, 8, 8);
        var d = sctx.getImageData(0, 0, 8, 8).data;
        var rr = 0,
          gg = 0,
          bb = 0;
        for (var k = 0; k < 64; k++) {
          rr += d[k * 4];
          gg += d[k * 4 + 1];
          bb += d[k * 4 + 2];
        }
        avg = [rr, gg, bb]
          .map(function (v) {
            return Math.round(v / 64).toString(16).padStart(2, "0");
          })
          .join("");
        file = await new Promise(function (resolve) {
          canvas.toBlob(resolve, "image/png");
        });
      } catch (err) {
        file = null;
      }
      if (file) st.textures++;
      else st.texturesUnreadable++;
      textureFiles.push(file);
      textureMeta.push({ name: entry.name, w: (img && (img.naturalWidth || img.width)) || 0, h: (img && (img.naturalHeight || img.height)) || 0, avg: avg, ok: !!file });
    }

    var sections = {};
    var parts = [];
    var off = 0;
    SECTIONS.forEach(function (s) {
      var arr = P[s[0]].get();
      var bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      sections[s[0]] = [off, arr.length, s[1].name];
      parts.push(bytes);
      off += bytes.byteLength;
      var pad = (4 - (off % 4)) % 4;
      if (pad) {
        parts.push(new Uint8Array(pad));
        off += pad;
      }
    });
    var data = model.getData ? model.getData() : {};
    var go = data.globalOffset || { x: 0, y: 0, z: 0 };
    var up = null;
    try {
      up = model.getUpVector ? model.getUpVector() : null;
    } catch (e) {
      up = null;
    }
    if (up && up.length !== 3 && up.x !== undefined) up = [up.x, up.y, up.z];
    if (!up || up.length !== 3) {
      var meta = data && data.metadata;
      var wuv = meta && meta["world up vector"];
      up = wuv && wuv.XYZ && wuv.XYZ.length === 3 ? wuv.XYZ : null;
    }
    var header = JSON.stringify({
      format: VERSION,
      job: jobName,
      roots: [root],
      file: t.name(root),
      model: modelName(model),
      nodes: P.ndb.n,
      frags: P.fdb.n,
      geoms: P.gmeta.n / GMETA,
      gmetaStride: GMETA,
      globalOffset: [go.x, go.y, go.z],
      unitScale: unitScale(model),
      units: model.getUnitString ? model.getUnitString() : undefined,
      up: up && up.length === 3 ? [up[0], up[1], up[2]] : undefined,
      strings: strings,
      materials: matList,
      materials3: matRecords,
      textures: textureMeta,
      sections: sections,
      stats: st,
      source: "Autodesk viewer on " + location.hostname + ", model " + modelName(model),
      extractedAt: new Date().toISOString(),
      extractor: "ifcstudio-extractor " + VERSION,
    });
    var hb = new TextEncoder().encode(header);
    var pre = new Uint8Array(12);
    pre.set(new TextEncoder().encode("EANWD1"), 0);
    new DataView(pre.buffer).setUint32(8, hb.byteLength, true);
    var blob = new Blob([pre, hb, new Uint8Array((4 - ((12 + hb.byteLength) % 4)) % 4)].concat(parts), { type: "application/octet-stream" });
    return { blob: blob, textures: textureFiles, nodes: P.ndb.n, frags: P.fdb.n, geoms: P.gmeta.n / GMETA, stats: st };
  }

  // Elements, by the rule tools on the IFC Studio side use: walking down from the file root, the first node that
  // is not a grouping level and holds none itself; under grouping-only branches, a node that owns geometry.
  function elementIds(model, root) {
    var t = treeOf(model);
    function isContainer(id) {
      var kids = t.kids(id);
      for (var i = 0; i < kids.length; i++) if (GROUP[t.type(kids[i])] && !(SKIP && SKIP.test(t.name(kids[i])))) return true;
      return false;
    }
    var out = [];
    var stack = t.kids(root);
    if (t.ownsFragments(root)) out.push(root);
    while (stack.length) {
      var id = stack.pop();
      if (SKIP && SKIP.test(t.name(id))) continue;
      if (!GROUP[t.type(id)] && !isContainer(id)) {
        out.push(id);
        continue;
      }
      if (t.ownsFragments(id)) out.push(id);
      t.kids(id).forEach(function (c) {
        stack.push(c);
      });
    }
    return out;
  }

  async function extractProps(model, root, jobName, mode, onProgress) {
    var ids = elementIds(model, root);
    var strings = [];
    var sI = new Map();
    function si(s) {
      s = s == null ? "" : String(s);
      var k = sI.get(s);
      if (k === undefined) {
        k = strings.length;
        strings.push(s);
        sI.set(s, k);
      }
      return k;
    }
    var numbers = [];
    var nI = new Map();
    function ni(v) {
      var x = +(+v).toPrecision(10);
      var k = nI.get(x);
      if (k === undefined) {
        k = numbers.length;
        numbers.push(x);
        nI.set(x, k);
      }
      return -k - 1;
    }
    var units = {};
    var rows = [];
    var options = { ignoreHidden: false, needsExternalId: true };
    if (mode !== "all") options.propFilter = KEY_PROPS.concat(["externalId"]);
    for (var i = 0; i < ids.length; i += 10000) {
      var batch = ids.slice(i, i + 10000);
      var props = await new Promise(function (resolve, reject) {
        model.getBulkProperties2(batch, options, resolve, reject);
      });
      for (var p = 0; p < props.length; p++) {
        var item = props[p];
        var row = [item.dbId];
        var seen = {};
        var list = item.properties || [];
        for (var q = 0; q < list.length; q++) {
          var pr = list[q];
          if (INTERNAL.test(pr.displayCategory || "")) continue;
          var key = (pr.displayCategory || "") + "/" + (pr.displayName || pr.attributeName || "");
          if (seen[key]) continue;
          if (mode !== "all" && /^(Phase Created|Level|ParametersMap|Parameters)\//.test(key)) continue;
          if (mode !== "all" && /^System Type\//.test(key) && !/^System Type\/Description$/.test(key)) continue;
          var v = pr.displayValue;
          if (v === "" || v === null || v === undefined) continue;
          if (typeof v === "string") {
            var m = /^[A-Za-z]+ "(.*)", #\d+$/.exec(v);
            if (m) v = m[1];
          }
          seen[key] = 1;
          var k = si(key);
          if (typeof v === "number") {
            row.push(k, ni(v));
            if (pr.units && units[k] === undefined) units[k] = String(pr.units);
          } else if (typeof v === "boolean") row.push(k, si(v ? "Yes" : "No"));
          else row.push(k, si(v));
        }
        if (item.externalId) row.push(si("__externalId__"), si(item.externalId));
        rows.push(row);
      }
      if (onProgress) onProgress("properties", Math.min(ids.length, i + batch.length), ids.length);
      await sleep();
    }
    var json = JSON.stringify({ format: VERSION, mode: mode === "all" ? "all" : "key", job: jobName, n: rows.length, strings: strings, numbers: numbers, units: units, rows: rows });
    return { blob: new Blob([json], { type: "application/json" }), elements: ids.length };
  }

  async function gzip(blob) {
    if (typeof CompressionStream === "undefined") return { blob: blob, gz: false };
    var stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    return { blob: await new Response(stream).blob(), gz: true };
  }

  /**
   * Extracts the given file roots (all source files when omitted) of the
   * viewer's models. Returns one job per source file with its geometry and
   * properties as Blobs.
   */
  async function extract(viewer, options) {
    options = options || {};
    var onProgress = options.onProgress || function () {};
    var models = modelsOf(viewer);
    if (!models.length) throw new Error("No model is open in the viewer.");
    var jobs = [];
    var used = {};
    var targets = [];
    models.forEach(function (model, mIndex) {
      fileRoots(model).forEach(function (root) {
        var key = mIndex + ":" + root;
        if (options.roots && options.roots.indexOf(key) < 0) return;
        targets.push({ model: model, root: root, key: key });
      });
    });
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var t = treeOf(target.model);
      var base = slug(t.name(target.root) || modelName(target.model));
      var name = base;
      for (var n = 2; used[name]; n++) name = base + "-" + n;
      used[name] = 1;
      onProgress({ index: i, total: targets.length, file: t.name(target.root), phase: "geometry", done: 0 });
      var geometry = await extractGeometry(target.model, target.root, name, function (phase, done) {
        onProgress({ index: i, total: targets.length, file: t.name(target.root), phase: phase, done: done });
      });
      var props = null;
      if (options.props !== "none") {
        props = await extractProps(target.model, target.root, name, options.props, function (phase, done, total) {
          onProgress({ index: i, total: targets.length, file: t.name(target.root), phase: phase, done: done, of: total });
        });
      }
      jobs.push({ name: name, file: t.name(target.root), model: modelName(target.model), bin: geometry.blob, props: props && props.blob, textures: geometry.textures, summary: { nodes: geometry.nodes, frags: geometry.frags, geoms: geometry.geoms, elements: props ? props.elements : 0, stats: geometry.stats } });
    }
    return jobs;
  }

  /** One .eapk download holding every job (browsers allow one automatic download per page). */
  async function bundle(jobs) {
    var parts = [new TextEncoder().encode("EAPK1")];
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var files = [["ifcstudio-" + job.name + ".bin", job.bin]];
      if (job.props) files.push(["ifcstudio-" + job.name + "-props.json", job.props]);
      (job.textures || []).forEach(function (tex, k) {
        if (tex) files.push(["ifcstudio-" + job.name + "-tex" + k + ".png", tex]);
      });
      for (var j = 0; j < files.length; j++) {
        // PNG is compressed already.
        var z = /\.png$/.test(files[j][0]) ? { blob: files[j][1], gz: false } : await gzip(files[j][1]);
        var nb = new TextEncoder().encode(files[j][0] + (z.gz ? ".gz" : ""));
        var h = new DataView(new ArrayBuffer(12));
        h.setUint32(0, nb.length, true);
        h.setFloat64(4, z.blob.size, true);
        parts.push(new Uint8Array(h.buffer), nb, z.blob);
      }
    }
    return new Blob(parts, { type: "application/octet-stream" });
  }

  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 60000);
  }

  // ---------------------------------------------------------------------------
  // Bookmarklet panel

  var panel = null;

  function open(appOrigin) {
    if (panel && panel.ready && panel.host.isConnected) {
      panel.host.style.display = "";
      return;
    }
    // A panel left from an earlier click (model not loaded yet) is rebuilt.
    var stale = document.querySelectorAll("[data-ifcstudio-extractor]");
    for (var k = 0; k < stale.length; k++) stale[k].remove();
    var viewer = findViewer();
    var host = document.createElement("div");
    host.setAttribute("data-ifcstudio-extractor", "");
    host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    document.body.appendChild(host);
    var style =
      ":host{all:initial}" +
      ".p{font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d2430;background:#fff;border:1px solid #d4d9e1;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);width:380px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden}" +
      ".h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e6e9ee;font-weight:600}" +
      ".h .x{margin-left:auto;border:0;background:none;font-size:18px;line-height:1;cursor:pointer;color:#5b6573}" +
      ".b{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px}" +
      ".m{color:#5b6573;font-size:12px}.ok{color:#137a3f}.warn{color:#9a5b00}.bad{color:#b42318}" +
      ".list{border:1px solid #e6e9ee;border-radius:8px;max-height:240px;overflow:auto}" +
      ".row{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-bottom:1px solid #f0f2f5;font-size:12px}.row:last-child{border-bottom:0}" +
      ".row span{flex:1;word-break:break-all}.row em{font-style:normal;color:#5b6573;white-space:nowrap}" +
      ".btns{display:flex;gap:8px;flex-wrap:wrap}" +
      "button.a{border:1px solid #1f5fd1;background:#2563eb;color:#fff;border-radius:6px;padding:6px 10px;font:600 12.5px system-ui;cursor:pointer}" +
      "button.s{border:1px solid #c9ced6;background:#fff;color:#1d2430;border-radius:6px;padding:6px 10px;font:500 12.5px system-ui;cursor:pointer}" +
      "button:disabled{opacity:.5;cursor:not-allowed}" +
      ".bar{height:4px;background:#e6e9ee;border-radius:2px;overflow:hidden}.bar i{display:block;height:100%;background:#2563eb;width:0}" +
      "label.o{display:flex;gap:6px;align-items:center;font-size:12px}";
    root.innerHTML =
      "<style>" +
      style +
      "</style>" +
      '<div class="p" role="dialog" aria-label="IFC Studio extractor">' +
      '<div class="h">IFC Studio · extract model<button class="x" title="Close" aria-label="Close">×</button></div>' +
      '<div class="b">' +
      '<div class="name"></div>' +
      '<div class="conn m">Looking for IFC Studio…</div>' +
      '<div class="files"></div>' +
      '<label class="o"><input type="radio" name="pm" value="all" checked> All properties</label>' +
      '<label class="o"><input type="radio" name="pm" value="key"> Key properties only (identity, level, system, size; faster)</label>' +
      '<div class="btns"><button class="a send" disabled>Send to IFC Studio</button><button class="s dl">Download .eapk</button></div>' +
      '<div class="bar"><i></i></div>' +
      '<div class="status m"></div>' +
      '<div class="m">Reads what this viewer shows and hands it to your IFC Studio window, or saves it as a file. Use it on models you are allowed to export.</div>' +
      "</div></div>";
    var $ = function (sel) {
      return root.querySelector(sel);
    };
    var state = { connected: false, session: null, busy: false, roots: [] };
    panel = { host: host, state: state, ready: false };
    $(".x").onclick = function () {
      host.style.display = "none";
    };
    var setStatus = function (text, cls) {
      var el = $(".status");
      el.textContent = text;
      el.className = "status m " + (cls || "");
    };
    var setBar = function (f) {
      $(".bar i").style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + "%";
    };

    if (!viewer) {
      $(".name").innerHTML = '<span class="bad">No Autodesk viewer model found on this page.</span>';
      $(".conn").textContent = "Open the model in the viewer, wait for it to load, then click the bookmarklet again.";
      $(".dl").disabled = true;
      return;
    }

    var models = modelsOf(viewer);
    if (!models.length) {
      $(".name").innerHTML = '<span class="warn">The model is still loading.</span>';
      $(".conn").textContent = "Wait until it has loaded, then click the bookmark again.";
      $(".dl").disabled = true;
      return;
    }
    panel.ready = true;
    $(".name").textContent = models.map(modelName).join(" + ");
    var rows = [];
    models.forEach(function (model, mIndex) {
      fileRoots(model).forEach(function (rootId) {
        rows.push({ key: mIndex + ":" + rootId, name: treeOf(model).name(rootId) || modelName(model), frags: countFragments(model, rootId) });
      });
    });
    var filesHtml = '<div class="m">' + rows.length + " source file" + (rows.length === 1 ? "" : "s") + ' · <a href="#" class="all">all</a> · <a href="#" class="none">none</a></div><div class="list">';
    rows.forEach(function (r, i) {
      filesHtml += '<label class="row"><input type="checkbox" data-i="' + i + '" checked><span></span><em>' + r.frags.toLocaleString() + " parts</em></label>";
    });
    $(".files").innerHTML = filesHtml + "</div>";
    root.querySelectorAll(".row span").forEach(function (el, i) {
      el.textContent = rows[i].name;
    });
    var boxes = function () {
      return Array.prototype.slice.call(root.querySelectorAll(".row input"));
    };
    $(".all").onclick = function (e) {
      e.preventDefault();
      boxes().forEach(function (b) {
        b.checked = true;
      });
    };
    $(".none").onclick = function (e) {
      e.preventDefault();
      boxes().forEach(function (b) {
        b.checked = false;
      });
    };
    var selected = function () {
      return boxes()
        .filter(function (b) {
          return b.checked;
        })
        .map(function (b) {
          return rows[+b.getAttribute("data-i")].key;
        });
    };
    var propsMode = function () {
      var r = root.querySelector('input[name="pm"]:checked');
      return r ? r.value : "all";
    };

    var loaded = function () {
      return models.every(function (m) {
        return !m.isLoadDone || m.isLoadDone();
      });
    };
    if (!loaded()) setStatus("The model is still loading; wait until it has finished before extracting.", "warn");

    // Handshake with the IFC Studio window that opened this page.
    var opener = null;
    try {
      opener = window.opener && !window.opener.closed ? window.opener : null;
    } catch (e) {
      opener = null;
    }
    var onMessage = function (event) {
      if (event.source !== opener || event.origin !== appOrigin) return;
      var d = event.data || {};
      if (d.source !== "ifcstudio") return;
      if (d.op === "welcome") {
        state.connected = true;
        state.session = d.session;
        $(".conn").innerHTML = '<span class="ok">● Connected to IFC Studio</span> (' + appOrigin.replace(/^https?:\/\//, "") + ")";
        $(".send").disabled = false;
      } else if (d.op === "ack") {
        setStatus("IFC Studio received " + (d.index + 1) + " of " + d.total + " files.", "ok");
      }
    };
    window.addEventListener("message", onMessage);
    if (opener) {
      try {
        opener.postMessage({ source: "ifcstudio-extractor", v: VERSION, op: "hello", model: $(".name").textContent }, appOrigin);
      } catch (e) {
        opener = null;
      }
    }
    setTimeout(function () {
      if (!state.connected) {
        $(".conn").innerHTML = opener ? '<span class="warn">○ IFC Studio did not answer.</span> Open this page from the Convert page, or download the file and drop it there.' : '<span class="warn">○ Not opened from IFC Studio.</span> Download the file and drop it on the Convert page.';
      }
    }, 1500);

    var run = async function (send) {
      if (state.busy) return;
      var roots = selected();
      if (!roots.length) return setStatus("Pick at least one file.", "warn");
      if (!loaded()) return setStatus("The model is still loading; wait until it has finished.", "warn");
      state.busy = true;
      $(".send").disabled = $(".dl").disabled = true;
      var started = Date.now();
      try {
        var jobs = await extract(viewer, {
          roots: roots,
          props: propsMode(),
          onProgress: function (p) {
            setBar((p.index + (p.phase === "properties" && p.of ? 0.5 + (0.5 * p.done) / p.of : 0.25)) / p.total);
            setStatus("Reading " + (p.index + 1) + " of " + p.total + ": " + p.file + " (" + p.phase + ")…");
          },
        });
        var missing = jobs.reduce(function (n, j) {
          return n + (j.summary.stats.missingGeometry || 0);
        }, 0);
        if (send && state.connected) {
          for (var i = 0; i < jobs.length; i++) {
            var j = jobs[i];
            opener.postMessage({ source: "ifcstudio-extractor", v: VERSION, op: "job", session: state.session, index: i, total: jobs.length, name: j.name, file: j.file, model: j.model, bin: j.bin, props: j.props, textures: j.textures, summary: j.summary }, appOrigin);
          }
          opener.postMessage({ source: "ifcstudio-extractor", v: VERSION, op: "done", session: state.session, total: jobs.length }, appOrigin);
          setStatus("Sent " + jobs.length + " file" + (jobs.length === 1 ? "" : "s") + " in " + Math.round((Date.now() - started) / 1000) + " s. Switch back to IFC Studio." + (missing ? " " + missing + " parts had no geometry loaded." : ""), "ok");
        } else {
          setStatus("Packing the download…");
          var blob = await bundle(jobs);
          download(blob, slug($(".name").textContent) + "-ifcstudio.eapk");
          setStatus("Downloaded " + (blob.size / 1048576).toFixed(1) + " MB. Drop the .eapk file on IFC Studio's Convert page." + (missing ? " " + missing + " parts had no geometry loaded." : ""), "ok");
        }
        setBar(1);
      } catch (error) {
        setStatus("Extraction failed: " + (error && error.message ? error.message : error), "bad");
      } finally {
        state.busy = false;
        $(".send").disabled = !state.connected;
        $(".dl").disabled = false;
      }
    };
    $(".send").onclick = function () {
      run(true);
    };
    $(".dl").onclick = function () {
      run(false);
    };
  }

  global.IFCStudioExtractor = { version: VERSION, extract: extract, bundle: bundle, fileRoots: fileRoots, elementIds: elementIds, modelName: modelName, open: open };
})(typeof window !== "undefined" ? window : globalThis);
