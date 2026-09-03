/* =====================================================
   GENERAL STORE MANAGEMENT — APPLICATION LOGIC
   Vanilla JS. Data persisted to localStorage.
   Storage is wrapped behind a small "repository" layer
   (DB.* functions) so a future Firebase/Supabase backend
   can replace the storage functions without touching the
   rest of the app.
===================================================== */

(function () {
  "use strict";

  /* ----------------------------------------------------
     0. CONSTANTS & STORAGE LAYER
  ---------------------------------------------------- */
  const STORAGE_KEY = "generalStoreDB_v1";
  const UNITS = ["pcs", "box", "packet", "ream", "dozen", "set", "roll", "kg", "liter", "meter", "pair"];
  const DEFAULT_CATEGORIES = [
    "Stationery", "Printing Materials", "Computer Accessories",
    "Electrical Items", "Cleaning Materials", "Office Equipment", "Furniture", "Other"
  ];

  function todayISO() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function blankDB() {
    return {
      products: [],
      categories: DEFAULT_CATEGORIES.slice(),
      departments: [],
      stockIn: [],
      stockOut: [],
      transactions: [], // combined ledger: {id, date, type: opening|in|out, productId, deptId, qty, receiver, note, refId}
      archive: { products: [], departments: [] },
      settings: {
        officeName: "জেনারেল স্টোর",
        officeAddress: "",
        officeLogo: "./assets/logo.png",
        officePhone: "",
        officeEmail: "",
        defaultMinStock: 5,
        dateFormat: "DD-MM-YYYY",
        theme: "light",
        lang: "bn"
      },
      counters: { product: 0, department: 0, txn: 0 }
    };
  }

  const DB = {
    _cache: null,

    load() {
      if (this._cache) return this._cache;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        this._cache = raw ? JSON.parse(raw) : blankDB();
      } catch (e) {
        console.error("Failed to read storage, starting fresh.", e);
        this._cache = blankDB();
      }
      // Defensive defaults for older/partial data
      const base = blankDB();
      this._cache = Object.assign({}, base, this._cache);
      this._cache.settings = Object.assign({}, base.settings, this._cache.settings || {});
      this._cache.archive = Object.assign({}, base.archive, this._cache.archive || {});
      this._cache.counters = Object.assign({}, base.counters, this._cache.counters || {});
      return this._cache;
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._cache));
        return true;
      } catch (e) {
        console.error("Failed to save storage.", e);
        toast("সংরক্ষণ ব্যর্থ হয়েছে। ব্রাউজার স্টোরেজ পূর্ণ হতে পারে।", true);
        return false;
      }
    },

    nextId(kind) {
      const db = this.load();
      db.counters[kind] = (db.counters[kind] || 0) + 1;
      return db.counters[kind];
    }
  };

  function pad3(n) { return String(n).padStart(3, "0"); }

  /* ----------------------------------------------------
     1. UTILITIES
  ---------------------------------------------------- */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function toast(msg, isError) {
    const stack = $("#toastStack");
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}-${m}-${y}`;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return (Math.round(n * 100) / 100).toLocaleString("en-US");
  }

  function escapeHTML(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function monthLabel(monthStr) {
    // monthStr = "2026-09"
    if (!monthStr) return "";
    const [y, m] = monthStr.split("-").map(Number);
    const names = ["জানুয়ারি","ফেব্রুয়ারি","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগস্ট","সেপ্টেম্বর","অক্টোবর","নভেম্বর","ডিসেম্বর"];
    return `${names[m - 1]} ${y}`;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function toCSV(rows) {
    return rows.map(r => r.map(cell => {
      const s = String(cell == null ? "" : cell);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
  }

  let confirmResolver = null;
  function confirmDialog(message) {
    return new Promise((resolve) => {
      $("#confirmMessage").textContent = message;
      $("#confirmOverlay").classList.remove("hidden");
      confirmResolver = resolve;
    });
  }
  $("#confirmOkBtn").addEventListener("click", () => {
    $("#confirmOverlay").classList.add("hidden");
    if (confirmResolver) confirmResolver(true);
  });
  $("#confirmCancelBtn").addEventListener("click", () => {
    $("#confirmOverlay").classList.add("hidden");
    if (confirmResolver) confirmResolver(false);
  });

  /* ----------------------------------------------------
     2. DATA ACCESSORS
  ---------------------------------------------------- */
  function activeProducts() { return DB.load().products.filter(p => !p.archived); }
  function activeDepartments() { return DB.load().departments.filter(d => !d.archived); }
  function getProduct(id) { return DB.load().products.find(p => p.id === id); }
  function getDept(id) { return DB.load().departments.find(d => d.id === id); }

  function productStockStatus(p) {
    if (p.currentStock <= 0) return "out";
    if (p.currentStock < p.minStock) return "low";
    return "ok";
  }

  function recalcProductStock(productId) {
    const db = DB.load();
    const p = getProduct(productId);
    if (!p) return;
    const ins = db.stockIn.filter(s => s.productId === productId).reduce((a, s) => a + s.qty, 0);
    const outs = db.stockOut.filter(s => s.productId === productId).reduce((a, s) => a + s.qty, 0);
    p.currentStock = round2(p.openingStock + ins - outs);
  }

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function addTransaction(tx) {
    const db = DB.load();
    tx.id = "TXN-" + pad3(DB.nextId("txn"));
    db.transactions.push(tx);
    return tx;
  }

  /* ----------------------------------------------------
     3. NAVIGATION
  ---------------------------------------------------- */
  const VIEW_TITLES = {
    dashboard: "ড্যাশবোর্ড", products: "মালামালের তালিকা", stockin: "মালামাল ক্রয় / Stock In",
    stockout: "দপ্তরে মালামাল প্রদান", departments: "দপ্তরসমূহ", transactions: "লেনদেনের ইতিহাস",
    reports: "রিপোর্ট", monthly: "মাসিক হিসাব", archive: "আর্কাইভ", settings: "সেটিংস"
  };

  function navigate(view) {
    $all(".view").forEach(v => v.classList.add("hidden"));
    const target = $("#view-" + view);
    if (target) target.classList.remove("hidden");
    $all(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    $("#viewTitle").textContent = VIEW_TITLES[view] || "";
    closeSidebarMobile();
    renderView(view);
  }

  function renderView(view) {
    switch (view) {
      case "dashboard": renderDashboard(); break;
      case "products": renderProducts(); break;
      case "stockin": renderStockIn(); break;
      case "stockout": renderStockOut(); break;
      case "departments": renderDepartments(); break;
      case "transactions": renderTransactions(); break;
      case "reports": renderReportsInit(); break;
      case "monthly": renderMonthlyInit(); break;
      case "archive": renderArchive(); break;
      case "settings": renderSettings(); break;
    }
  }

  $all(".nav-item").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.view)));

  function closeSidebarMobile() {
    $("#sidebar").classList.remove("open");
    $("#sidebarOverlay").classList.remove("show");
  }
  $("#hamburgerBtn").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
    $("#sidebarOverlay").classList.toggle("show");
  });
  $("#sidebarOverlay").addEventListener("click", closeSidebarMobile);

  /* ----------------------------------------------------
     4. DASHBOARD
  ---------------------------------------------------- */
  function renderDashboard() {
    const db = DB.load();
    const products = activeProducts();
    const depts = activeDepartments();
    const now = new Date();
    const curMonth = now.toISOString().slice(0, 7);

    const totalStock = products.reduce((a, p) => a + p.currentStock, 0);
    const monthIn = db.stockIn.filter(s => s.date.slice(0, 7) === curMonth).reduce((a, s) => a + s.qty, 0);
    const monthOut = db.stockOut.filter(s => s.date.slice(0, 7) === curMonth).reduce((a, s) => a + s.qty, 0);
    const lowStock = products.filter(p => productStockStatus(p) === "low");
    const outStock = products.filter(p => productStockStatus(p) === "out");

    const cards = [
      { label: "মোট মালামাল", value: products.length, cls: "" },
      { label: "মোট স্টক", value: fmtNum(totalStock), cls: "" },
      { label: "এই মাসে ক্রয়", value: fmtNum(monthIn), cls: "" },
      { label: "এই মাসে বিতরণ", value: fmtNum(monthOut), cls: "" },
      { label: "মোট দপ্তর", value: depts.length, cls: "" },
      { label: "লো স্টক", value: lowStock.length, cls: "warn" },
      { label: "স্টক শেষ", value: outStock.length, cls: "danger" }
    ];
    $("#dashCards").innerHTML = cards.map(c => `
      <div class="dash-card ${c.cls}">
        <div class="dc-label">${c.label}</div>
        <div class="dc-value">${c.value}</div>
      </div>`).join("");

    // Recent activity: last 10 (in + out), most recent first
    const activity = [
      ...db.stockIn.map(s => ({ type: "in", date: s.date, ts: s.createdAt, text: `${productName(s.productId)} — ${fmtNum(s.qty)} ${productUnit(s.productId)} স্টক ইন হয়েছে।` })),
      ...db.stockOut.map(s => ({ type: "out", date: s.date, ts: s.createdAt, text: `${deptName(s.deptId)}-কে ${productName(s.productId)} — ${fmtNum(s.qty)} ${productUnit(s.productId)} প্রদান করা হয়েছে।` }))
    ].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10);

    $("#recentActivity").innerHTML = activity.length ? activity.map(a => `
      <div class="activity-item">
        <span class="activity-dot ${a.type}"></span>
        <span>${a.text}<span class="activity-date">${fmtDate(a.date)}</span></span>
      </div>`).join("") : `<p class="empty-state">এখনো কোনো কার্যক্রম নেই।</p>`;

    let alertsHTML = "";
    outStock.forEach(p => { alertsHTML += `<div class="alert-item out"><span>⚠ ${escapeHTML(p.name)}</span><span>স্টক শেষ</span></div>`; });
    lowStock.forEach(p => { alertsHTML += `<div class="alert-item low"><span>⚠ ${escapeHTML(p.name)}</span><span>${fmtNum(p.currentStock)} ${p.unit}</span></div>`; });
    $("#stockAlerts").innerHTML = alertsHTML || `<p class="empty-state">সব মালামালের স্টক পর্যাপ্ত আছে।</p>`;
  }

  function productName(id) { const p = getProduct(id); return p ? p.name : "(অজানা)"; }
  function productUnit(id) { const p = getProduct(id); return p ? p.unit : ""; }
  function deptName(id) { const d = getDept(id); return d ? d.name : "(অজানা)"; }

  /* ----------------------------------------------------
     5. PRODUCTS
  ---------------------------------------------------- */
  function fillSelectPreservingValue(el, optionsHTML) {
    if (!el) return;
    const prevValue = el.value;
    el.innerHTML = optionsHTML;
    if (prevValue && $all("option", el).some(o => o.value === prevValue)) {
      el.value = prevValue;
    }
  }

  function populateCategorySelects() {
    const db = DB.load();
    const opts = db.categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
    fillSelectPreservingValue($("#prodCategoryFilter"), `<option value="">সকল ক্যাটাগরি</option>` + opts);
    fillSelectPreservingValue($("#repStockCategory"), `<option value="">সকল ক্যাটাগরি</option>` + opts);
  }

  function populateProductSelects() {
    const products = activeProducts();
    const opts = products.map(p => `<option value="${p.id}">${escapeHTML(p.name)} (${escapeHTML(p.unit)})</option>`).join("");
    ["#stockInProduct", "#stockOutProduct", "#repProdSelect", "#stockInProductFilter", "#txnProductFilter", "#repDeptProduct"].forEach(sel => {
      const el = $(sel);
      if (!el) return;
      const keepFirst = el.querySelector('option[value=""]');
      fillSelectPreservingValue(el, (keepFirst ? keepFirst.outerHTML : "") + opts);
    });
  }

  function populateDeptSelects() {
    const depts = activeDepartments();
    const opts = depts.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join("");
    ["#stockOutDept", "#repDeptSelect", "#stockOutDeptFilter", "#txnDeptFilter"].forEach(sel => {
      const el = $(sel);
      if (!el) return;
      const keepFirst = el.querySelector('option[value=""]');
      fillSelectPreservingValue(el, (keepFirst ? keepFirst.outerHTML : "") + opts);
    });
  }

  function renderProducts() {
    populateCategorySelects();
    const catF = $("#prodCategoryFilter").value;
    const stockF = $("#prodStockFilter").value;
    const q = $("#prodSearchBox").value.trim().toLowerCase();

    let rows = activeProducts();
    if (catF) rows = rows.filter(p => p.category === catF);
    if (stockF) rows = rows.filter(p => productStockStatus(p) === stockF);
    if (q) rows = rows.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));

    const tbody = $("#productsTable tbody");
    tbody.innerHTML = rows.map(p => {
      const status = productStockStatus(p);
      const pill = status === "out" ? `<span class="pill pill-danger">স্টক শেষ</span>`
        : status === "low" ? `<span class="pill pill-warn">লো স্টক</span>`
        : `<span class="pill pill-ok">পর্যাপ্ত</span>`;
      return `<tr>
        <td>${p.id}</td>
        <td>${escapeHTML(p.name)}</td>
        <td>${escapeHTML(p.category)}</td>
        <td>${escapeHTML(p.brand || "-")}</td>
        <td>${escapeHTML(p.unit)}</td>
        <td>${fmtNum(p.currentStock)} ${pill}</td>
        <td>${fmtNum(p.minStock)}</td>
        <td>${fmtDate(p.dateAdded)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit-product="${p.id}">সম্পাদনা</button>
          <button class="btn btn-danger btn-sm" data-archive-product="${p.id}">আর্কাইভ</button>
        </td>
      </tr>`;
    }).join("");
    $("#productsEmpty").hidden = rows.length > 0;

    $all("[data-edit-product]").forEach(b => b.addEventListener("click", () => openProductModal(b.dataset.editProduct)));
    $all("[data-archive-product]").forEach(b => b.addEventListener("click", async () => {
      const ok = await confirmDialog("এই মালামালটি আর্কাইভ করতে চান?");
      if (!ok) return;
      const p = getProduct(b.dataset.archiveProduct);
      p.archived = true;
      DB.save();
      toast("মালামাল আর্কাইভ করা হয়েছে।");
      renderProducts();
    }));
  }

  ["#prodCategoryFilter", "#prodStockFilter", "#prodSearchBox"].forEach(sel => {
    $(sel).addEventListener("input", renderProducts);
    $(sel).addEventListener("change", renderProducts);
  });

  function openProductModal(editId) {
    const db = DB.load();
    const editing = editId ? getProduct(editId) : null;
    const unitOpts = UNITS.map(u => `<option value="${u}" ${editing && editing.unit === u ? "selected" : ""}>${u}</option>`).join("");
    const catOpts = db.categories.map(c => `<option value="${escapeHTML(c)}" ${editing && editing.category === c ? "selected" : ""}>${escapeHTML(c)}</option>`).join("");

    $("#modalBox").innerHTML = `
      <div class="modal-head"><h2>${editing ? "মালামাল সম্পাদনা" : "নতুন মালামাল"}</h2><button class="modal-close" id="modalCloseBtn">✕</button></div>
      <form class="app-form" id="productForm">
        <div class="form-row"><label>মালামালের নাম <span class="req">*</span></label>
          <input type="text" id="pfName" required value="${editing ? escapeHTML(editing.name) : ""}"></div>
        <div class="form-row"><label>ক্যাটাগরি <span class="req">*</span></label>
          <select id="pfCategory" required>${catOpts}</select></div>
        <div class="form-row"><label>ব্র্যান্ড</label>
          <input type="text" id="pfBrand" value="${editing ? escapeHTML(editing.brand || "") : ""}"></div>
        <div class="form-row"><label>একক <span class="req">*</span></label>
          <select id="pfUnit" required>${unitOpts}</select></div>
        <div class="form-row"><label>প্রারম্ভিক স্টক (Opening Stock) <span class="req">*</span></label>
          <input type="number" id="pfOpening" min="0" step="any" required value="${editing ? editing.openingStock : 0}" ${editing ? "disabled" : ""}></div>
        <div class="form-row"><label>নূন্যতম স্টক লেভেল <span class="req">*</span></label>
          <input type="number" id="pfMinStock" min="0" step="any" required value="${editing ? editing.minStock : db.settings.defaultMinStock}"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="modalCancelBtn">বাতিল</button>
          <button type="submit" class="btn btn-primary">সংরক্ষণ করুন</button>
        </div>
      </form>`;
    showModal();
    $("#modalCloseBtn").addEventListener("click", closeModal);
    $("#modalCancelBtn").addEventListener("click", closeModal);
    $("#productForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#pfName").value.trim();
      const category = $("#pfCategory").value;
      const brand = $("#pfBrand").value.trim();
      const unit = $("#pfUnit").value;
      const minStock = round2($("#pfMinStock").value);
      if (!name) return;

      if (editing) {
        editing.name = name; editing.category = category; editing.brand = brand;
        editing.unit = unit; editing.minStock = minStock;
        toast("মালামাল হালনাগাদ করা হয়েছে।");
      } else {
        const opening = round2($("#pfOpening").value);
        const id = "PRD-" + pad3(DB.nextId("product"));
        const product = {
          id, name, category, brand, unit,
          openingStock: opening, currentStock: opening, minStock,
          dateAdded: todayISO(), archived: false
        };
        db.products.push(product);
        addTransaction({ date: product.dateAdded, type: "opening", productId: id, deptId: "", qty: opening, receiver: "", note: "প্রারম্ভিক স্টক", createdAt: Date.now() });
        toast("নতুন মালামাল যোগ করা হয়েছে।");
      }
      DB.save();
      closeModal();
      renderProducts();
      populateProductSelects();
    });
  }

  $("#addProductBtn").addEventListener("click", () => openProductModal(null));

  function openCategoryModal() {
    const db = DB.load();
    function renderList() {
      return db.categories.map((c, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <span>${escapeHTML(c)}</span>
          <button class="btn btn-danger btn-sm" data-del-cat="${i}">মুছুন</button>
        </div>`).join("");
    }
    $("#modalBox").innerHTML = `
      <div class="modal-head"><h2>ক্যাটাগরি ব্যবস্থাপনা</h2><button class="modal-close" id="modalCloseBtn">✕</button></div>
      <div class="app-form">
        <div id="catList">${renderList()}</div>
        <div class="form-row" style="flex-direction:row; gap:8px; align-items:flex-end;">
          <div style="flex:1;"><label>নতুন ক্যাটাগরি</label><input type="text" id="newCatInput"></div>
          <button class="btn btn-primary" id="addCatBtn">যোগ করুন</button>
        </div>
      </div>`;
    showModal();
    $("#modalCloseBtn").addEventListener("click", closeModal);
    function bindDel() {
      $all("[data-del-cat]").forEach(b => b.addEventListener("click", () => {
        db.categories.splice(Number(b.dataset.delCat), 1);
        DB.save();
        $("#catList").innerHTML = renderList();
        bindDel();
        populateCategorySelects();
      }));
    }
    bindDel();
    $("#addCatBtn").addEventListener("click", () => {
      const v = $("#newCatInput").value.trim();
      if (!v) return;
      if (db.categories.includes(v)) { toast("এই ক্যাটাগরি ইতিমধ্যে আছে।", true); return; }
      db.categories.push(v);
      DB.save();
      $("#newCatInput").value = "";
      $("#catList").innerHTML = renderList();
      bindDel();
      populateCategorySelects();
    });
  }
  $("#manageCategoriesBtn").addEventListener("click", openCategoryModal);

  /* ----------------------------------------------------
     6. STOCK IN
  ---------------------------------------------------- */
  function renderStockIn() {
    populateProductSelects();
    $("#stockInDate").value = $("#stockInDate").value || todayISO();
    updateUnitLabel("#stockInProduct", "#stockInUnitLabel");

    const db = DB.load();
    const monthF = $("#stockInMonthFilter").value;
    const prodF = $("#stockInProductFilter").value;
    let rows = db.stockIn.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (monthF) rows = rows.filter(r => r.date.slice(0, 7) === monthF);
    if (prodF) rows = rows.filter(r => r.productId === prodF);

    $("#stockInTable tbody").innerHTML = rows.map(r => `
      <tr>
        <td>${fmtDate(r.date)}</td><td>${r.txnId || "-"}</td>
        <td>${escapeHTML(productName(r.productId))}</td>
        <td>${fmtNum(r.qty)} ${escapeHTML(productUnit(r.productId))}</td>
        <td>${escapeHTML(r.challan || "-")}</td>
        <td>${escapeHTML(r.note || "-")}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit-in="${r.id}">সম্পাদনা</button>
          <button class="btn btn-danger btn-sm" data-del-in="${r.id}">মুছুন</button>
        </td>
      </tr>`).join("");
    $("#stockInEmpty").hidden = rows.length > 0;

    $all("[data-edit-in]").forEach(b => b.addEventListener("click", () => loadStockInForEdit(b.dataset.editIn)));
    $all("[data-del-in]").forEach(b => b.addEventListener("click", () => deleteStockIn(b.dataset.delIn)));
  }

  $("#stockInMonthFilter").addEventListener("change", renderStockIn);
  $("#stockInProductFilter").addEventListener("change", renderStockIn);
  $("#stockInProduct").addEventListener("change", () => updateUnitLabel("#stockInProduct", "#stockInUnitLabel"));

  function updateUnitLabel(selectSel, labelSel) {
    const id = $(selectSel).value;
    const p = getProduct(id);
    $(labelSel).textContent = p ? p.unit : "";
  }

  function loadStockInForEdit(id) {
    const db = DB.load();
    const r = db.stockIn.find(x => x.id === id);
    if (!r) return;
    $("#stockInEditId").value = r.id;
    $("#stockInDate").value = r.date;
    $("#stockInProduct").value = r.productId;
    $("#stockInQty").value = r.qty;
    $("#stockInChallan").value = r.challan || "";
    $("#stockInNote").value = r.note || "";
    $("#stockInCancelBtn").hidden = false;
    updateUnitLabel("#stockInProduct", "#stockInUnitLabel");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("#stockInCancelBtn").addEventListener("click", () => {
    $("#stockInForm").reset();
    $("#stockInEditId").value = "";
    $("#stockInDate").value = todayISO();
    $("#stockInCancelBtn").hidden = true;
  });

  $("#stockInForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const db = DB.load();
    const editId = $("#stockInEditId").value;
    const productId = $("#stockInProduct").value;
    const qty = round2($("#stockInQty").value);
    const date = $("#stockInDate").value;
    const challan = $("#stockInChallan").value.trim();
    const note = $("#stockInNote").value.trim();
    if (!productId || !qty || qty <= 0) { toast("সঠিক মালামাল ও পরিমাণ দিন।", true); return; }

    if (editId) {
      const r = db.stockIn.find(x => x.id === editId);
      r.date = date; r.productId = productId; r.qty = qty; r.challan = challan; r.note = note;
      const tx = db.transactions.find(t => t.refId === r.id && t.type === "in");
      if (tx) { tx.date = date; tx.productId = productId; tx.qty = qty; tx.note = note; }
      toast("স্টক ইন হালনাগাদ করা হয়েছে।");
    } else {
      const id = "SI-" + pad3(DB.nextId("txn"));
      const record = { id, date, productId, qty, challan, note, createdAt: Date.now() };
      db.stockIn.push(record);
      const tx = addTransaction({ date, type: "in", productId, deptId: "", qty, receiver: "", note, refId: id, createdAt: Date.now() });
      record.txnId = tx.id;
      toast("স্টক ইন সংরক্ষণ করা হয়েছে।");
    }
    recalcProductStock(productId);
    DB.save();
    $("#stockInForm").reset();
    $("#stockInEditId").value = "";
    $("#stockInDate").value = todayISO();
    $("#stockInCancelBtn").hidden = true;
    renderStockIn();
    renderDashboard();
  });

  async function deleteStockIn(id) {
    const ok = await confirmDialog("এই স্টক ইন এন্ট্রিটি মুছে ফেলতে চান? স্টক ব্যালেন্স পুনরায় হিসাব হবে।");
    if (!ok) return;
    const db = DB.load();
    const idx = db.stockIn.findIndex(x => x.id === id);
    if (idx === -1) return;
    const productId = db.stockIn[idx].productId;
    db.stockIn.splice(idx, 1);
    db.transactions = db.transactions.filter(t => !(t.refId === id && t.type === "in"));
    recalcProductStock(productId);
    DB.save();
    toast("স্টক ইন এন্ট্রি মুছে ফেলা হয়েছে।");
    renderStockIn();
    renderDashboard();
  }

  /* ----------------------------------------------------
     7. STOCK OUT
  ---------------------------------------------------- */
  function renderStockOut() {
    populateProductSelects();
    populateDeptSelects();
    $("#stockOutDate").value = $("#stockOutDate").value || todayISO();
    updateUnitLabel("#stockOutProduct", "#stockOutUnitLabel");
    updateAvailHint();

    const db = DB.load();
    const monthF = $("#stockOutMonthFilter").value;
    const deptF = $("#stockOutDeptFilter").value;
    let rows = db.stockOut.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (monthF) rows = rows.filter(r => r.date.slice(0, 7) === monthF);
    if (deptF) rows = rows.filter(r => r.deptId === deptF);

    $("#stockOutTable tbody").innerHTML = rows.map(r => `
      <tr>
        <td>${fmtDate(r.date)}</td>
        <td>${escapeHTML(deptName(r.deptId))}</td>
        <td>${escapeHTML(productName(r.productId))}</td>
        <td>${fmtNum(r.qty)} ${escapeHTML(productUnit(r.productId))}</td>
        <td>${escapeHTML(r.receiver)}</td>
        <td>${escapeHTML(r.note || "-")}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit-out="${r.id}">সম্পাদনা</button>
          <button class="btn btn-danger btn-sm" data-del-out="${r.id}">মুছুন</button>
        </td>
      </tr>`).join("");
    $("#stockOutEmpty").hidden = rows.length > 0;

    $all("[data-edit-out]").forEach(b => b.addEventListener("click", () => loadStockOutForEdit(b.dataset.editOut)));
    $all("[data-del-out]").forEach(b => b.addEventListener("click", () => deleteStockOut(b.dataset.delOut)));
  }

  $("#stockOutMonthFilter").addEventListener("change", renderStockOut);
  $("#stockOutDeptFilter").addEventListener("change", renderStockOut);
  $("#stockOutProduct").addEventListener("change", () => { updateUnitLabel("#stockOutProduct", "#stockOutUnitLabel"); updateAvailHint(); });

  function updateAvailHint() {
    const p = getProduct($("#stockOutProduct").value);
    $("#stockOutAvailHint").textContent = p ? `বর্তমান স্টক: ${fmtNum(p.currentStock)} ${p.unit}` : "";
  }

  function loadStockOutForEdit(id) {
    const db = DB.load();
    const r = db.stockOut.find(x => x.id === id);
    if (!r) return;
    $("#stockOutEditId").value = r.id;
    $("#stockOutDate").value = r.date;
    $("#stockOutDept").value = r.deptId;
    $("#stockOutProduct").value = r.productId;
    $("#stockOutQty").value = r.qty;
    $("#stockOutReceiver").value = r.receiver;
    $("#stockOutNote").value = r.note || "";
    $("#stockOutCancelBtn").hidden = false;
    updateUnitLabel("#stockOutProduct", "#stockOutUnitLabel");
    updateAvailHint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("#stockOutCancelBtn").addEventListener("click", resetStockOutForm);
  function resetStockOutForm() {
    $("#stockOutForm").reset();
    $("#stockOutEditId").value = "";
    $("#stockOutDate").value = todayISO();
    $("#stockOutCancelBtn").hidden = true;
    $("#stockOutError").hidden = true;
  }

  $("#stockOutForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const db = DB.load();
    const editId = $("#stockOutEditId").value;
    const productId = $("#stockOutProduct").value;
    const deptId = $("#stockOutDept").value;
    const qty = round2($("#stockOutQty").value);
    const date = $("#stockOutDate").value;
    const receiver = $("#stockOutReceiver").value.trim();
    const note = $("#stockOutNote").value.trim();
    const errEl = $("#stockOutError");
    errEl.hidden = true;

    if (!productId || !deptId || !qty || qty <= 0 || !receiver) {
      errEl.textContent = "সকল আবশ্যক ঘর পূরণ করুন।"; errEl.hidden = false; return;
    }
    const product = getProduct(productId);
    // Available stock excludes the quantity of the record being edited (it will be re-applied)
    let available = product.currentStock;
    if (editId) {
      const prev = db.stockOut.find(x => x.id === editId);
      if (prev && prev.productId === productId) available += prev.qty;
    }
    if (qty > available) {
      errEl.textContent = `পর্যাপ্ত মালামাল স্টকে নেই। বর্তমান স্টক: ${fmtNum(available)} ${product.unit}।`;
      errEl.hidden = false;
      return;
    }

    const confirmMsg = `দপ্তর: ${deptName(deptId)}\nমালামাল: ${productName(productId)}\nপরিমাণ: ${fmtNum(qty)} ${product.unit}\nগ্রহণকারী: ${receiver}\n\nবিতরণ নিশ্চিত করতে চান?`;
    const ok = await confirmDialog(confirmMsg);
    if (!ok) return;

    if (editId) {
      const r = db.stockOut.find(x => x.id === editId);
      const oldProductId = r.productId;
      r.date = date; r.productId = productId; r.deptId = deptId; r.qty = qty; r.receiver = receiver; r.note = note;
      const tx = db.transactions.find(t => t.refId === r.id && t.type === "out");
      if (tx) { tx.date = date; tx.productId = productId; tx.deptId = deptId; tx.qty = qty; tx.receiver = receiver; tx.note = note; }
      DB.save();
      recalcProductStock(oldProductId);
      if (oldProductId !== productId) recalcProductStock(productId);
      toast("বিতরণ এন্ট্রি হালনাগাদ করা হয়েছে।");
    } else {
      const id = "SO-" + pad3(DB.nextId("txn"));
      const record = { id, date, productId, deptId, qty, receiver, note, createdAt: Date.now() };
      db.stockOut.push(record);
      const tx = addTransaction({ date, type: "out", productId, deptId, qty, receiver, note, refId: id, createdAt: Date.now() });
      record.txnId = tx.id;
      recalcProductStock(productId);
      DB.save();
      toast("মালামাল বিতরণ সংরক্ষণ করা হয়েছে।");
    }
    resetStockOutForm();
    renderStockOut();
    renderDashboard();
  });

  async function deleteStockOut(id) {
    const ok = await confirmDialog("এই বিতরণ এন্ট্রিটি মুছে ফেলতে চান? স্টক ব্যালেন্স পুনরায় হিসাব হবে।");
    if (!ok) return;
    const db = DB.load();
    const idx = db.stockOut.findIndex(x => x.id === id);
    if (idx === -1) return;
    const productId = db.stockOut[idx].productId;
    db.stockOut.splice(idx, 1);
    db.transactions = db.transactions.filter(t => !(t.refId === id && t.type === "out"));
    recalcProductStock(productId);
    DB.save();
    toast("বিতরণ এন্ট্রি মুছে ফেলা হয়েছে।");
    renderStockOut();
    renderDashboard();
  }

  /* ----------------------------------------------------
     8. DEPARTMENTS
  ---------------------------------------------------- */
  function renderDepartments() {
    const q = $("#deptSearchBox").value.trim().toLowerCase();
    let rows = activeDepartments();
    if (q) rows = rows.filter(d => d.name.toLowerCase().includes(q));
    $("#deptTable tbody").innerHTML = rows.map(d => `
      <tr>
        <td>${d.id}</td><td>${escapeHTML(d.name)}</td><td>${escapeHTML(d.person || "-")}</td>
        <td>${d.status === "inactive" ? `<span class="pill pill-warn">নিষ্ক্রিয়</span>` : `<span class="pill pill-ok">সক্রিয়</span>`}</td>
        <td>${fmtDate(d.dateAdded)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit-dept="${d.id}">সম্পাদনা</button>
          <button class="btn btn-danger btn-sm" data-archive-dept="${d.id}">আর্কাইভ</button>
        </td>
      </tr>`).join("");
    $("#deptEmpty").hidden = rows.length > 0;
    $all("[data-edit-dept]").forEach(b => b.addEventListener("click", () => openDeptModal(b.dataset.editDept)));
    $all("[data-archive-dept]").forEach(b => b.addEventListener("click", async () => {
      const ok = await confirmDialog("এই দপ্তরটি আর্কাইভ করতে চান?");
      if (!ok) return;
      getDept(b.dataset.archiveDept).archived = true;
      DB.save();
      toast("দপ্তর আর্কাইভ করা হয়েছে।");
      renderDepartments();
      populateDeptSelects();
    }));
  }
  $("#deptSearchBox").addEventListener("input", renderDepartments);

  function openDeptModal(editId) {
    const db = DB.load();
    const editing = editId ? getDept(editId) : null;
    $("#modalBox").innerHTML = `
      <div class="modal-head"><h2>${editing ? "দপ্তর সম্পাদনা" : "নতুন দপ্তর"}</h2><button class="modal-close" id="modalCloseBtn">✕</button></div>
      <form class="app-form" id="deptForm">
        <div class="form-row"><label>দপ্তরের নাম <span class="req">*</span></label>
          <input type="text" id="dfName" required value="${editing ? escapeHTML(editing.name) : ""}"></div>
        <div class="form-row"><label>দায়িত্বপ্রাপ্ত ব্যক্তি</label>
          <input type="text" id="dfPerson" value="${editing ? escapeHTML(editing.person || "") : ""}"></div>
        <div class="form-row"><label>অবস্থা</label>
          <select id="dfStatus">
            <option value="active" ${!editing || editing.status === "active" ? "selected" : ""}>সক্রিয়</option>
            <option value="inactive" ${editing && editing.status === "inactive" ? "selected" : ""}>নিষ্ক্রিয়</option>
          </select></div>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="modalCancelBtn">বাতিল</button>
          <button type="submit" class="btn btn-primary">সংরক্ষণ করুন</button>
        </div>
      </form>`;
    showModal();
    $("#modalCloseBtn").addEventListener("click", closeModal);
    $("#modalCancelBtn").addEventListener("click", closeModal);
    $("#deptForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#dfName").value.trim();
      if (!name) return;
      const person = $("#dfPerson").value.trim();
      const status = $("#dfStatus").value;
      if (editing) {
        editing.name = name; editing.person = person; editing.status = status;
        toast("দপ্তর হালনাগাদ করা হয়েছে।");
      } else {
        const id = "DEP-" + pad3(DB.nextId("department"));
        db.departments.push({ id, name, person, status, dateAdded: todayISO(), archived: false });
        toast("নতুন দপ্তর যোগ করা হয়েছে।");
      }
      DB.save();
      closeModal();
      renderDepartments();
      populateDeptSelects();
    });
  }
  $("#addDeptBtn").addEventListener("click", () => openDeptModal(null));

  /* ----------------------------------------------------
     9. TRANSACTIONS
  ---------------------------------------------------- */
  function renderTransactions() {
    populateProductSelects();
    populateDeptSelects();
    const db = DB.load();
    const typeF = $("#txnTypeFilter").value;
    const fromF = $("#txnFromDate").value;
    const toF = $("#txnToDate").value;
    const prodF = $("#txnProductFilter").value;
    const deptF = $("#txnDeptFilter").value;

    let rows = db.transactions.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (typeF) rows = rows.filter(t => t.type === typeF);
    if (fromF) rows = rows.filter(t => t.date >= fromF);
    if (toF) rows = rows.filter(t => t.date <= toF);
    if (prodF) rows = rows.filter(t => t.productId === prodF);
    if (deptF) rows = rows.filter(t => t.deptId === deptF);

    const typeLabel = { opening: "Opening Stock", in: "Stock In", out: "Stock Out" };
    $("#txnTable tbody").innerHTML = rows.map(t => `
      <tr>
        <td>${t.id}</td><td>${fmtDate(t.date)}</td><td>${typeLabel[t.type] || t.type}</td>
        <td>${escapeHTML(productName(t.productId))}</td>
        <td>${t.deptId ? escapeHTML(deptName(t.deptId)) : "-"}</td>
        <td>${fmtNum(t.qty)} ${escapeHTML(productUnit(t.productId))}</td>
        <td>${escapeHTML(t.receiver || "-")}</td>
        <td>${escapeHTML(t.note || "-")}</td>
      </tr>`).join("");
    $("#txnEmpty").hidden = rows.length > 0;
    DB._lastTxnRows = rows;
  }
  ["#txnTypeFilter", "#txnFromDate", "#txnToDate", "#txnProductFilter", "#txnDeptFilter"].forEach(sel => {
    $(sel).addEventListener("change", renderTransactions);
  });
  $("#txnExportBtn").addEventListener("click", () => {
    const rows = DB._lastTxnRows || [];
    const typeLabel = { opening: "Opening Stock", in: "Stock In", out: "Stock Out" };
    const csvRows = [["Transaction ID", "Date", "Type", "Product", "Department", "Quantity", "Unit", "Receiver", "Note"]];
    rows.forEach(t => csvRows.push([t.id, fmtDate(t.date), typeLabel[t.type], productName(t.productId), t.deptId ? deptName(t.deptId) : "", t.qty, productUnit(t.productId), t.receiver || "", t.note || ""]));
    downloadFile("transaction-history.csv", toCSV(csvRows), "text/csv");
  });

  /* ----------------------------------------------------
     10. REPORTS
  ---------------------------------------------------- */
  function renderReportsInit() {
    populateProductSelects();
    populateDeptSelects();
    populateCategorySelects();
  }

  $all("#view-reports .report-tab").forEach(tab => tab.addEventListener("click", () => {
    $all("#view-reports .report-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $all(".report-pane").forEach(p => p.classList.add("hidden"));
    $("#report-" + tab.dataset.report).classList.remove("hidden");
  }));

  function officeReportHeader(subtitle) {
    const s = DB.load().settings;
    return `<div class="report-doc-head">
      <div class="office">${escapeHTML(s.officeName)}</div>
      <div class="sub">${escapeHTML(s.officeAddress || "")}</div>
      <div class="sub">${subtitle}</div>
    </div>`;
  }

  // --- Department report ---
  $("#repDeptGenerate").addEventListener("click", () => {
    const db = DB.load();
    const deptId = $("#repDeptSelect").value;
    const from = $("#repDeptFrom").value;
    const to = $("#repDeptTo").value;
    const prodF = $("#repDeptProduct").value;
    if (!deptId) { toast("একটি দপ্তর নির্বাচন করুন।", true); return; }

    let rows = db.stockOut.filter(r => r.deptId === deptId);
    if (from) rows = rows.filter(r => r.date >= from);
    if (to) rows = rows.filter(r => r.date <= to);
    if (prodF) rows = rows.filter(r => r.productId === prodF);
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const totals = {};
    rows.forEach(r => {
      const u = productUnit(r.productId);
      const key = productName(r.productId) + "||" + u;
      totals[key] = (totals[key] || 0) + r.qty;
    });

    const period = (from || to) ? `সময়কাল: ${from ? fmtDate(from) : "শুরু থেকে"} - ${to ? fmtDate(to) : "বর্তমান"}` : "সময়কাল: সর্বমোট";
    let html = `<div class="report-doc" id="deptReportDoc">`;
    html += officeReportHeader("দপ্তর-ভিত্তিক বিতরণ রিপোর্ট");
    html += `<div class="report-meta"><span>দপ্তর: <strong>${escapeHTML(deptName(deptId))}</strong></span><span>${period}</span></div>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>তারিখ</th><th>মালামাল</th><th>একক</th><th>পরিমাণ</th><th>গ্রহণকারী</th></tr></thead><tbody>`;
    if (rows.length) {
      rows.forEach(r => {
        html += `<tr><td>${fmtDate(r.date)}</td><td>${escapeHTML(productName(r.productId))}</td><td>${escapeHTML(productUnit(r.productId))}</td><td>${fmtNum(r.qty)}</td><td>${escapeHTML(r.receiver)}</td></tr>`;
      });
    } else {
      html += `<tr><td colspan="5" style="text-align:center;color:var(--text-3);">এই সময়ে কোনো বিতরণ নেই।</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<div class="report-total"><div>সর্বমোট বিতরণ:</div>` +
      Object.entries(totals).map(([k, v]) => { const [n, u] = k.split("||"); return `<div>${escapeHTML(n)}: ${fmtNum(v)} ${escapeHTML(u)}</div>`; }).join("") +
      `</div>`;
    html += `<div class="sign-row"><div>প্রস্তুতকারী</div><div>যাচাইকারী</div><div>অনুমোদনকারী</div></div>`;
    html += `<div class="form-actions" style="margin-top:16px;"><button class="btn btn-primary" id="printDeptReportBtn">🖨 Print Report</button></div>`;
    html += `</div>`;
    $("#repDeptOutput").innerHTML = html;
    $("#printDeptReportBtn").addEventListener("click", () => printElement("deptReportDoc"));
  });

  // --- Product ledger report ---
  $("#repProdGenerate").addEventListener("click", () => {
    const db = DB.load();
    const productId = $("#repProdSelect").value;
    if (!productId) { toast("একটি মালামাল নির্বাচন করুন।", true); return; }
    const p = getProduct(productId);

    const entries = [];
    entries.push({ date: p.dateAdded, desc: "Opening", inQ: p.openingStock, outQ: 0 });
    db.stockIn.filter(s => s.productId === productId).forEach(s => entries.push({ date: s.date, desc: "Stock In" + (s.challan ? ` (${s.challan})` : ""), inQ: s.qty, outQ: 0 }));
    db.stockOut.filter(s => s.productId === productId).forEach(s => entries.push({ date: s.date, desc: deptName(s.deptId) + " → " + s.receiver, inQ: 0, outQ: s.qty }));
    entries.sort((a, b) => a.date.localeCompare(b.date));

    let balance = 0;
    const ledgerRows = entries.map(e => {
      balance += e.inQ - e.outQ;
      return `<tr><td>${fmtDate(e.date)}</td><td>${escapeHTML(e.desc)}</td><td>${e.inQ ? fmtNum(e.inQ) : "-"}</td><td>${e.outQ ? fmtNum(e.outQ) : "-"}</td><td>${fmtNum(balance)}</td></tr>`;
    }).join("");

    const inByMonth = {};
    db.stockIn.filter(s => s.productId === productId).forEach(s => { const m = s.date.slice(0, 7); inByMonth[m] = (inByMonth[m] || 0) + s.qty; });
    const outByDept = {};
    db.stockOut.filter(s => s.productId === productId).forEach(s => { outByDept[s.deptId] = (outByDept[s.deptId] || 0) + s.qty; });

    let html = `<div class="report-doc" id="prodReportDoc">`;
    html += officeReportHeader("মালামাল-ভিত্তিক লেজার রিপোর্ট");
    html += `<div class="report-meta"><span>মালামাল: <strong>${escapeHTML(p.name)}</strong> (${p.id})</span><span>একক: ${escapeHTML(p.unit)}</span></div>`;
    html += `<div class="report-meta"><span>প্রারম্ভিক স্টক: ${fmtNum(p.openingStock)}</span><span>বর্তমান স্টক: ${fmtNum(p.currentStock)}</span></div>`;
    html += `<h3 style="margin:16px 0 8px;font-size:14.5px;">Stock Ledger</h3>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>Date</th><th>Description</th><th>In</th><th>Out</th><th>Balance</th></tr></thead><tbody>${ledgerRows}</tbody></table>`;

    html += `<h3 style="margin:18px 0 8px;font-size:14.5px;">মাসিক Stock In সারসংক্ষেপ</h3>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>মাস</th><th>মোট Stock In</th></tr></thead><tbody>` +
      (Object.keys(inByMonth).length ? Object.entries(inByMonth).sort().map(([m, v]) => `<tr><td>${monthLabel(m)}</td><td>${fmtNum(v)}</td></tr>`).join("") : `<tr><td colspan="2" style="text-align:center;color:var(--text-3);">কোনো তথ্য নেই।</td></tr>`) +
      `</tbody></table>`;

    html += `<h3 style="margin:18px 0 8px;font-size:14.5px;">দপ্তর-ভিত্তিক Stock Out সারসংক্ষেপ</h3>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>দপ্তর</th><th>মোট গ্রহণ</th></tr></thead><tbody>` +
      (Object.keys(outByDept).length ? Object.entries(outByDept).map(([d, v]) => `<tr><td>${escapeHTML(deptName(d))}</td><td>${fmtNum(v)}</td></tr>`).join("") : `<tr><td colspan="2" style="text-align:center;color:var(--text-3);">কোনো তথ্য নেই।</td></tr>`) +
      `</tbody></table>`;

    html += `<div class="form-actions" style="margin-top:16px;"><button class="btn btn-primary" id="printProdReportBtn">🖨 Print Report</button></div>`;
    html += `</div>`;
    $("#repProdOutput").innerHTML = html;
    $("#printProdReportBtn").addEventListener("click", () => printElement("prodReportDoc"));
  });

  // --- Current stock report ---
  function renderStockReport() {
    const catF = $("#repStockCategory").value;
    let rows = activeProducts();
    if (catF) rows = rows.filter(p => p.category === catF);
    rows.sort((a, b) => a.name.localeCompare(b.name, "bn"));

    let html = `<div class="report-doc" id="repStockOutput_doc">`;
    html += officeReportHeader("বর্তমান স্টক রিপোর্ট");
    html += `<div class="report-meta"><span>তারিখ: ${fmtDate(todayISO())}</span><span>মোট মালামাল: ${rows.length}</span></div>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>আইডি</th><th>নাম</th><th>ক্যাটাগরি</th><th>একক</th><th>বর্তমান স্টক</th><th>নূন্যতম স্টক</th><th>অবস্থা</th></tr></thead><tbody>`;
    rows.forEach(p => {
      const status = productStockStatus(p);
      const label = status === "out" ? "স্টক শেষ" : status === "low" ? "লো স্টক" : "পর্যাপ্ত";
      html += `<tr><td>${p.id}</td><td>${escapeHTML(p.name)}</td><td>${escapeHTML(p.category)}</td><td>${escapeHTML(p.unit)}</td><td>${fmtNum(p.currentStock)}</td><td>${fmtNum(p.minStock)}</td><td>${label}</td></tr>`;
    });
    html += `</tbody></table></div>`;
    $("#repStockOutput").innerHTML = html;
  }
  $("#repStockCategory").addEventListener("change", renderStockReport);

  $("#repStockExport").addEventListener("click", () => {
    const catF = $("#repStockCategory").value;
    let rows = activeProducts();
    if (catF) rows = rows.filter(p => p.category === catF);
    const csvRows = [["ID", "Name", "Category", "Unit", "Current Stock", "Min Stock", "Status"]];
    rows.forEach(p => csvRows.push([p.id, p.name, p.category, p.unit, p.currentStock, p.minStock, productStockStatus(p)]));
    downloadFile("current-stock.csv", toCSV(csvRows), "text/csv");
  });

  // Initialize stock report when its tab opens
  document.addEventListener("click", (e) => {
    if (e.target.matches('.report-tab[data-report="stock"]')) renderStockReport();
  });

  // Print via data-target trigger (used by static buttons)
  $all(".printable-trigger").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const wrap = $("#" + targetId);
      const doc = wrap ? wrap.querySelector(".report-doc") : null;
      if (doc) printElement(doc.id || (doc.id = "tmp_print_doc"));
      else toast("প্রথমে রিপোর্ট তৈরি করুন।", true);
    });
  });

  function printElement(id) {
    const el = document.getElementById(id);
    if (!el) return;
    $("#printArea").innerHTML = el.outerHTML;
    window.print();
  }

  /* ----------------------------------------------------
     11. MONTHLY REPORT
  ---------------------------------------------------- */
  function renderMonthlyInit() {
    if (!$("#monthlySelect").value) $("#monthlySelect").value = todayISO().slice(0, 7);
  }

  $("#monthlyGenerate").addEventListener("click", generateMonthlyReport);

  function generateMonthlyReport() {
    const db = DB.load();
    const month = $("#monthlySelect").value;
    if (!month) { toast("একটি মাস নির্বাচন করুন।", true); return; }

    const monthIn = db.stockIn.filter(s => s.date.slice(0, 7) === month);
    const monthOut = db.stockOut.filter(s => s.date.slice(0, 7) === month);
    const totalIn = monthIn.reduce((a, s) => a + s.qty, 0);
    const totalOut = monthOut.reduce((a, s) => a + s.qty, 0);

    // Per-product: opening (as of month start), in, out, closing
    const products = activeProducts();
    const productRows = products.map(p => {
      const before = db.stockIn.filter(s => s.productId === p.id && s.date.slice(0, 7) < month).reduce((a, s) => a + s.qty, 0)
        - db.stockOut.filter(s => s.productId === p.id && s.date.slice(0, 7) < month).reduce((a, s) => a + s.qty, 0)
        + p.openingStock;
      const inQ = monthIn.filter(s => s.productId === p.id).reduce((a, s) => a + s.qty, 0);
      const outQ = monthOut.filter(s => s.productId === p.id).reduce((a, s) => a + s.qty, 0);
      return { name: p.name, unit: p.unit, opening: before, inQ, outQ, closing: round2(before + inQ - outQ) };
    }).filter(r => r.opening || r.inQ || r.outQ || r.closing);

    const deptTotals = {};
    monthOut.forEach(s => { deptTotals[s.deptId] = (deptTotals[s.deptId] || 0) + s.qty; });

    const closingStockAll = productRows.reduce((a, r) => a + r.closing, 0);

    let html = `<div class="report-doc" id="monthlyReportDoc">`;
    html += officeReportHeader(`মাসিক স্টক রিপোর্ট — ${monthLabel(month)}`);
    html += `<div class="report-meta"><span>মোট Stock In: <strong>${fmtNum(totalIn)}</strong></span><span>মোট Stock Out: <strong>${fmtNum(totalOut)}</strong></span><span>মাস শেষে মোট স্টক: <strong>${fmtNum(closingStockAll)}</strong></span></div>`;

    html += `<h3 style="margin:16px 0 8px;font-size:14.5px;">মালামাল-ভিত্তিক হিসাব</h3>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>মালামাল</th><th>একক</th><th>Opening</th><th>Stock In</th><th>Stock Out</th><th>Closing</th></tr></thead><tbody>`;
    if (productRows.length) {
      productRows.forEach(r => { html += `<tr><td>${escapeHTML(r.name)}</td><td>${escapeHTML(r.unit)}</td><td>${fmtNum(r.opening)}</td><td>${fmtNum(r.inQ)}</td><td>${fmtNum(r.outQ)}</td><td>${fmtNum(r.closing)}</td></tr>`; });
    } else {
      html += `<tr><td colspan="6" style="text-align:center;color:var(--text-3);">এই মাসে কোনো কার্যক্রম নেই।</td></tr>`;
    }
    html += `</tbody></table>`;

    html += `<h3 style="margin:18px 0 8px;font-size:14.5px;">দপ্তর-ভিত্তিক বিতরণ</h3>`;
    html += `<table class="data-table" style="width:100%;"><thead><tr><th>দপ্তর</th><th>মোট গ্রহণ</th></tr></thead><tbody>`;
    if (Object.keys(deptTotals).length) {
      Object.entries(deptTotals).forEach(([d, v]) => { html += `<tr><td>${escapeHTML(deptName(d))}</td><td>${fmtNum(v)}</td></tr>`; });
    } else {
      html += `<tr><td colspan="2" style="text-align:center;color:var(--text-3);">এই মাসে কোনো বিতরণ নেই।</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<div class="sign-row"><div>প্রস্তুতকারী</div><div>যাচাইকারী</div><div>অনুমোদনকারী</div></div>`;
    html += `</div>`;
    $("#monthlyOutput").innerHTML = html;
  }

  /* ----------------------------------------------------
     12. ARCHIVE
  ---------------------------------------------------- */
  function renderArchive() {
    const db = DB.load();
    const archivedProducts = db.products.filter(p => p.archived);
    const archivedDepts = db.departments.filter(d => d.archived);

    $("#archiveProductsBody").innerHTML = archivedProducts.map(p => `
      <tr><td>${p.id}</td><td>${escapeHTML(p.name)}</td><td>${escapeHTML(p.category)}</td><td>${fmtNum(p.currentStock)}</td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" data-restore-product="${p.id}">পুনরুদ্ধার</button>
        <button class="btn btn-danger btn-sm" data-purge-product="${p.id}">স্থায়ী মুছুন</button>
      </td></tr>`).join("");
    $("#archiveProductsEmpty").hidden = archivedProducts.length > 0;

    $("#archiveDeptBody").innerHTML = archivedDepts.map(d => `
      <tr><td>${d.id}</td><td>${escapeHTML(d.name)}</td><td>${escapeHTML(d.person || "-")}</td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" data-restore-dept="${d.id}">পুনরুদ্ধার</button>
        <button class="btn btn-danger btn-sm" data-purge-dept="${d.id}">স্থায়ী মুছুন</button>
      </td></tr>`).join("");
    $("#archiveDeptEmpty").hidden = archivedDepts.length > 0;

    $all("[data-restore-product]").forEach(b => b.addEventListener("click", () => {
      getProduct(b.dataset.restoreProduct).archived = false;
      DB.save(); toast("মালামাল পুনরুদ্ধার করা হয়েছে।"); renderArchive(); populateProductSelects();
    }));
    $all("[data-purge-product]").forEach(b => b.addEventListener("click", async () => {
      const ok = await confirmDialog("এই মালামালটি স্থায়ীভাবে মুছে ফেলতে চান? এই কাজটি ফিরিয়ে নেওয়া যাবে না।");
      if (!ok) return;
      db.products = db.products.filter(p => p.id !== b.dataset.purgeProduct);
      DB.save(); toast("স্থায়ীভাবে মুছে ফেলা হয়েছে।"); renderArchive();
    }));
    $all("[data-restore-dept]").forEach(b => b.addEventListener("click", () => {
      getDept(b.dataset.restoreDept).archived = false;
      DB.save(); toast("দপ্তর পুনরুদ্ধার করা হয়েছে।"); renderArchive(); populateDeptSelects();
    }));
    $all("[data-purge-dept]").forEach(b => b.addEventListener("click", async () => {
      const ok = await confirmDialog("এই দপ্তরটি স্থায়ীভাবে মুছে ফেলতে চান? এই কাজটি ফিরিয়ে নেওয়া যাবে না।");
      if (!ok) return;
      db.departments = db.departments.filter(d => d.id !== b.dataset.purgeDept);
      DB.save(); toast("স্থায়ীভাবে মুছে ফেলা হয়েছে।"); renderArchive();
    }));
  }

  $all("#view-archive .report-tab[data-archive]").forEach(tab => tab.addEventListener("click", () => {
    $all("#view-archive .report-tab[data-archive]").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $all(".archive-pane").forEach(p => p.classList.add("hidden"));
    $("#archive-" + tab.dataset.archive).classList.remove("hidden");
  }));

  /* ----------------------------------------------------
     13. SETTINGS / BACKUP / RESTORE
  ---------------------------------------------------- */
  function renderSettings() {
    const s = DB.load().settings;
    $("#setOfficeName").value = s.officeName;
    $("#setOfficeAddress").value = s.officeAddress;
    $("#setOfficeLogo").value = s.officeLogo;
    $("#setOfficePhone").value = s.officePhone;
    $("#setOfficeEmail").value = s.officeEmail;
    $("#setDefaultMinStock").value = s.defaultMinStock;
    $("#setTheme").value = s.theme;
  }

  $("#settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const db = DB.load();
    const s = db.settings;
    s.officeName = $("#setOfficeName").value.trim() || "জেনারেল স্টোর";
    s.officeAddress = $("#setOfficeAddress").value.trim();
    s.officeLogo = $("#setOfficeLogo").value.trim() || "./assets/logo.png";
    s.officePhone = $("#setOfficePhone").value.trim();
    s.officeEmail = $("#setOfficeEmail").value.trim();
    s.defaultMinStock = round2($("#setDefaultMinStock").value) || 0;
    s.theme = $("#setTheme").value;
    DB.save();
    applySettingsToUI();
    toast("সেটিংস সংরক্ষণ করা হয়েছে।");
  });

  function applySettingsToUI() {
    const s = DB.load().settings;
    $("#brandOfficeName").textContent = s.officeName;
    $("#brandLogo").src = s.officeLogo;
    document.documentElement.setAttribute("data-theme", s.theme);
  }

  $("#backupBtn").addEventListener("click", () => {
    const db = DB.load();
    downloadFile(`office-store-backup-${todayISO()}.json`, JSON.stringify(db, null, 2), "application/json");
    toast("ব্যাকআপ ডাউনলোড করা হয়েছে।");
  });

  $("#restoreBtn").addEventListener("click", () => $("#restoreFileInput").click());
  $("#restoreFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await confirmDialog("রিস্টোর করলে বর্তমান সকল তথ্য প্রতিস্থাপিত হবে। আপনি কি নিশ্চিত?");
    e.target.value = "";
    if (!ok) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.products)) {
        throw new Error("invalid file");
      }
      DB._cache = Object.assign(blankDB(), parsed);
      DB.save();
      toast("ডেটা সফলভাবে রিস্টোর করা হয়েছে।");
      applySettingsToUI();
      navigate("dashboard");
    } catch (err) {
      console.error(err);
      toast("অবৈধ ব্যাকআপ ফাইল। রিস্টোর ব্যর্থ হয়েছে।", true);
    }
  });

  /* ----------------------------------------------------
     14. MODAL HELPERS
  ---------------------------------------------------- */
  function showModal() { $("#modalOverlay").classList.remove("hidden"); }
  function closeModal() { $("#modalOverlay").classList.add("hidden"); $("#modalBox").innerHTML = ""; }
  $("#modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });

  /* ----------------------------------------------------
     15. GLOBAL SEARCH
  ---------------------------------------------------- */
  const searchInput = $("#globalSearch");
  const searchResults = $("#searchResults");

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.classList.remove("show"); searchResults.innerHTML = ""; return; }
    const db = DB.load();
    const results = [];

    db.products.filter(p => !p.archived).forEach(p => {
      if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) {
        results.push({ tag: "মালামাল", label: `${p.name} (${p.id})`, view: "products" });
      }
    });
    db.departments.filter(d => !d.archived).forEach(d => {
      if (d.name.toLowerCase().includes(q)) results.push({ tag: "দপ্তর", label: d.name, view: "departments" });
    });
    db.stockOut.forEach(s => {
      if ((s.receiver || "").toLowerCase().includes(q)) results.push({ tag: "গ্রহণকারী", label: `${s.receiver} — ${productName(s.productId)}`, view: "stockout" });
    });
    db.transactions.forEach(t => {
      if (t.id.toLowerCase().includes(q) || t.date.includes(q)) results.push({ tag: "লেনদেন", label: `${t.id} — ${fmtDate(t.date)}`, view: "transactions" });
    });

    const top = results.slice(0, 12);
    searchResults.innerHTML = top.length
      ? top.map(r => `<div class="search-result-item" data-goto="${r.view}"><span class="search-result-tag">${r.tag}</span> — ${escapeHTML(r.label)}</div>`).join("")
      : `<div class="search-result-item">কোনো ফলাফল পাওয়া যায়নি।</div>`;
    searchResults.classList.add("show");

    $all("[data-goto]", searchResults).forEach(el => el.addEventListener("click", () => {
      navigate(el.dataset.goto);
      searchResults.classList.remove("show");
      searchInput.value = "";
    }));
  });
  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) searchResults.classList.remove("show");
  });

  /* ----------------------------------------------------
     16. LANGUAGE TOGGLE (basic — Bangla is default/primary)
  ---------------------------------------------------- */
  $("#langToggle").addEventListener("click", () => {
    toast("সম্পূর্ণ ইংরেজি সংস্করণ শীঘ্রই আসছে। বর্তমানে বাংলা ইন্টারফেস সক্রিয় আছে।");
  });

  /* ----------------------------------------------------
     17. INIT
  ---------------------------------------------------- */
  function init() {
    DB.load();
    applySettingsToUI();
    populateCategorySelects();
    populateProductSelects();
    populateDeptSelects();
    $("#stockInDate").value = todayISO();
    $("#stockOutDate").value = todayISO();
    navigate("dashboard");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
