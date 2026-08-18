(() => {
  "use strict";

  const STORAGE_KEY = "obaObaGestao.v1";
  const defaultState = {
    toys: [],
    clients: [],
    quotes: [],
    settings: { phone: "(31) 99682-3046", instagram: "@obaobabrinquedos" }
  };

  let state = structuredClone(defaultState);
  let syncTimer = null;
  let remoteErrorShown = false;
  let appEventsInitialized = false;
  let currentSection = "dashboard";
  let quoteFilter = "all";
  let editingToyImage = "";
  let quoteItems = [];
  let clientFormContext = "clients";
  let profileClientId = "";
  let calendarCursor = startOfMonth(new Date());
  let selectedCalendarDate = toISODate(new Date());

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const compactCurrency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const dateLong = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  const monthLong = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });

  function showLogin(message = "") {
    document.body.classList.remove("auth-pending");
    document.body.classList.add("auth-required");
    document.body.style.overflow = "";
    $("#loginError").textContent = message;
    $("#loginPassword").value = "";
    setTimeout(() => $("#loginPassword").focus(), 0);
  }

  function showApp() {
    document.body.classList.remove("auth-pending", "auth-required");
  }

  async function checkSession() {
    if (!/^https?:$/.test(location.protocol)) return true;
    try {
      const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload.authenticated === true;
    } catch {
      return false;
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const submit = $("#loginSubmit");
    const error = $("#loginError");
    submit.disabled = true;
    submit.querySelector("span").textContent = "Entrando...";
    error.textContent = "";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value })
      });
      const payload = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() : {};
      if (!response.ok) throw new Error(payload.error || "Não foi possível entrar.");
      await startApp();
    } catch (loginError) {
      error.textContent = loginError instanceof Error ? loginError.message : "Não foi possível entrar.";
      $("#loginPassword").select();
    } finally {
      submit.disabled = false;
      submit.querySelector("span").textContent = "Entrar no painel";
    }
  }

  async function logout() {
    clearTimeout(syncTimer);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } });
    } finally {
      showLogin("Você saiu da conta com segurança.");
    }
  }

  function initAuthEvents() {
    $("#loginForm").addEventListener("submit", submitLogin);
    $("#passwordToggle").addEventListener("click", () => {
      const input = $("#loginPassword");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      $("#passwordToggle").setAttribute("aria-label", showing ? "Mostrar senha" : "Ocultar senha");
    });
  }

  function loadLocalState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return stored ? { ...defaultState, ...stored, settings: { ...defaultState.settings, ...(stored.settings || {}) } } : structuredClone(defaultState);
    } catch {
      return structuredClone(defaultState);
    }
  }

  function mergeState(value) {
    return value && typeof value === "object" ? {
      ...defaultState,
      ...value,
      toys: Array.isArray(value.toys) ? value.toys : [],
      clients: Array.isArray(value.clients) ? value.clients : [],
      quotes: Array.isArray(value.quotes) ? value.quotes : [],
      settings: { ...defaultState.settings, ...(value.settings || {}) }
    } : structuredClone(defaultState);
  }

  function setSyncStatus(status, message) {
    const dot = $("#syncDot");
    const text = $("#syncText");
    if (!dot || !text) return;
    dot.classList.toggle("syncing", status === "syncing");
    dot.classList.toggle("offline", status === "offline");
    text.textContent = message;
  }

  function hasBusinessData(value) {
    return value.toys.length > 0 || value.clients.length > 0 || value.quotes.length > 0 || value.settings.phone !== defaultState.settings.phone || value.settings.instagram !== defaultState.settings.instagram;
  }

  async function hydrateState() {
    const local = loadLocalState();
    state = local;
    if (!/^https?:$/.test(location.protocol)) {
      setSyncStatus("offline", "Modo local neste dispositivo");
      return true;
    }
    try {
      setSyncStatus("syncing", "Conectando ao banco...");
      const response = await fetch("/api/state", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (response.status === 401) {
        showLogin("Sua sessão expirou. Entre novamente.");
        return false;
      }
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) throw new Error("API indisponível");
      const payload = await response.json();
      if (payload.state) {
        state = mergeState(payload.state);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } else if (hasBusinessData(local)) {
        const migrated = await persistRemoteState(local, true);
        if (!migrated) return !document.body.classList.contains("auth-required");
      }
      setSyncStatus("online", "Dados sincronizados na nuvem");
      return true;
    } catch (error) {
      console.error("Falha ao carregar dados da nuvem", error);
      setSyncStatus("offline", "Sem conexão • usando dados locais");
      return true;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      toast("O armazenamento está cheio. Tente usar fotos menores.", "error");
      console.error(error);
    }
    clearTimeout(syncTimer);
    const snapshot = structuredClone(state);
    syncTimer = setTimeout(() => { void persistRemoteState(snapshot); }, 250);
  }

  async function persistRemoteState(snapshot, silent = false) {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      setSyncStatus("syncing", "Salvando na nuvem...");
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ state: snapshot }),
        credentials: "same-origin",
        keepalive: true
      });
      const payload = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() : {};
      if (response.status === 401) {
        showLogin("Sua sessão expirou. Entre novamente.");
        return false;
      }
      if (!response.ok) throw new Error(payload.error || "Não foi possível salvar os dados.");
      remoteErrorShown = false;
      setSyncStatus("online", "Dados sincronizados na nuvem");
      return true;
    } catch (error) {
      console.error("Falha ao salvar dados na nuvem", error);
      setSyncStatus("offline", "Falha ao sincronizar • dados locais preservados");
      if (!silent && !remoteErrorShown) {
        toast(error instanceof Error ? error.message : "Falha ao sincronizar com a nuvem.", "error");
        remoteErrorShown = true;
      }
      return false;
    }
  }

  function uid(prefix) {
    return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`}`;
  }

  function parseISODate(value) {
    if (!value) return null;
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function toISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
  function formatDate(value) { const date = parseISODate(value); return date ? date.toLocaleDateString("pt-BR") : "—"; }
  function formatMoney(value) { return currency.format(Number(value) || 0); }
  function escapeHTML(value = "") {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
  }

  function toast(message, type = "success") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = message;
    $("#toastContainer").appendChild(element);
    setTimeout(() => element.remove(), 3200);
  }

  function openModal(id) {
    const modal = $(`#${id}`);
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeModal(modal) {
    const target = typeof modal === "string" ? $(`#${modal}`) : modal.closest(".modal");
    if (!target) return;
    target.classList.remove("is-open");
    target.setAttribute("aria-hidden", "true");
    if (!$(".modal.is-open")) document.body.style.overflow = "";
  }

  const pageInfo = {
    dashboard: ["PAINEL DE CONTROLE", "Olá! Vamos organizar a diversão?"],
    toys: ["MEU CATÁLOGO", "Brinquedos"],
    clients: ["RELACIONAMENTO", "Clientes"],
    quotes: ["PROPOSTAS COMERCIAIS", "Orçamentos"],
    calendar: ["EVENTOS APROVADOS", "Agenda"]
  };

  function navigate(section) {
    currentSection = section;
    $$(".page-section").forEach(page => page.classList.toggle("active", page.dataset.page === section));
    $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.section === section));
    $("#pageEyebrow").textContent = pageInfo[section][0];
    $("#pageTitle").textContent = pageInfo[section][1];
    history.replaceState(null, "", `#${section}`);
    if (section === "dashboard") renderDashboard();
    if (section === "toys") renderToys();
    if (section === "clients") renderClients();
    if (section === "quotes") renderQuotes();
    if (section === "calendar") renderCalendar();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderDashboard() {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    const approvedThisMonth = state.quotes.filter(q => q.status === "approved" && parseISODate(q.eventDate)?.getMonth() === month && parseISODate(q.eventDate)?.getFullYear() === year);
    const open = state.quotes.filter(q => q.status !== "approved");
    $("#statEvents").textContent = approvedThisMonth.length;
    $("#statQuotes").textContent = open.length;
    $("#statToys").textContent = state.toys.length;
    $("#statUnits").textContent = `${state.toys.reduce((sum, toy) => sum + Number(toy.stock || 0), 0)} unidades disponíveis`;
    $("#statRevenue").textContent = compactCurrency.format(approvedThisMonth.reduce((sum, q) => sum + Number(q.total || 0), 0));

    const today = toISODate(now);
    const upcoming = state.quotes
      .filter(q => q.status === "approved" && q.eventDate >= today)
      .sort((a, b) => `${a.eventDate}${a.startTime}`.localeCompare(`${b.eventDate}${b.startTime}`))
      .slice(0, 3);
    $("#upcomingEvents").innerHTML = upcoming.length ? upcoming.map(q => {
      const date = parseISODate(q.eventDate);
      return `<button class="event-row" data-edit-quote="${q.id}">
        <span class="event-date-box"><b>${String(date.getDate()).padStart(2, "0")}</b><span>${date.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "").toUpperCase()}</span></span>
        <span class="event-info"><strong>${escapeHTML(q.clientName || "Cliente não informado")}</strong><span>${escapeHTML(q.startTime)}–${escapeHTML(q.endTime)} • ${q.items.length} ${q.items.length === 1 ? "item" : "itens"}</span></span>
        <span class="event-value">${formatMoney(q.total)}</span>
      </button>`;
    }).join("") : emptyState("○", "Nenhum evento próximo", "Aprove um orçamento para ele aparecer aqui.", "Criar orçamento", "new-quote");

    const recent = [...state.quotes].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 4);
    $("#recentQuotes").innerHTML = recent.length ? recent.map(q => `<button class="recent-row" data-edit-quote="${q.id}">
      <span class="recent-avatar">${escapeHTML((q.clientName || "?").charAt(0).toUpperCase())}</span>
      <span><strong>${escapeHTML(q.clientName || "Sem cliente")}</strong><small>${escapeHTML(q.number)} • ${formatMoney(q.total)}</small></span>
      ${statusBadge(q.status)}
    </button>`).join("") : emptyState("◇", "Nenhum orçamento criado", "Seus orçamentos recentes aparecerão aqui.", "Novo orçamento", "new-quote");
  }

  function emptyState(icon, title, text, buttonText = "", action = "") {
    return `<div class="empty-state"><div><span class="empty-icon">${icon}</span><strong>${title}</strong><p>${text}</p>${buttonText ? `<button class="btn btn-soft btn-small" data-action="${action}">${buttonText}</button>` : ""}</div></div>`;
  }

  function statusBadge(status) {
    const labels = { approved: "Aprovado", pending: "Enviado", draft: "Rascunho" };
    return `<span class="status-pill ${status || "draft"}">${labels[status] || labels.draft}</span>`;
  }

  function openToyForm(toy = null) {
    $("#toyForm").reset();
    $("#toyId").value = toy?.id || "";
    $("#toyName").value = toy?.name || "";
    $("#toyPrice").value = toy?.price ?? "";
    $("#toyStock").value = toy?.stock ?? 1;
    $("#toyCategory").value = toy?.category || "Infláveis";
    $("#toyDescription").value = toy?.description || "";
    editingToyImage = toy?.image || "";
    $("#toyModalTitle").textContent = toy ? "Editar brinquedo" : "Cadastrar brinquedo";
    updateToyImagePreview();
    openModal("toyModal");
    setTimeout(() => $("#toyName").focus(), 120);
  }

  function updateToyImagePreview() {
    const preview = $("#toyImagePreview");
    preview.src = editingToyImage;
    preview.hidden = !editingToyImage;
    $("#uploadPrompt").hidden = !!editingToyImage;
    $("#changePhoto").hidden = !editingToyImage;
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const maxWidth = 900;
          const maxHeight = 675;
          const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", .68));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function saveToy(event) {
    event.preventDefault();
    const id = $("#toyId").value;
    const toy = {
      id: id || uid("toy"),
      name: $("#toyName").value.trim(),
      price: Number($("#toyPrice").value),
      stock: Number($("#toyStock").value),
      category: $("#toyCategory").value,
      description: $("#toyDescription").value.trim(),
      image: editingToyImage,
      updatedAt: new Date().toISOString()
    };
    if (id) state.toys = state.toys.map(item => item.id === id ? toy : item);
    else state.toys.unshift(toy);
    saveState();
    closeModal("toyModal");
    renderToys();
    toast(id ? "Brinquedo atualizado com sucesso." : "Brinquedo cadastrado com sucesso.");
  }

  function renderToys() {
    const term = $("#toySearch").value.trim().toLocaleLowerCase("pt-BR");
    const toys = state.toys.filter(toy => `${toy.name} ${toy.category} ${toy.description}`.toLocaleLowerCase("pt-BR").includes(term));
    const units = state.toys.reduce((sum, toy) => sum + Number(toy.stock || 0), 0);
    const average = state.toys.length ? state.toys.reduce((sum, toy) => sum + Number(toy.price || 0), 0) / state.toys.length : 0;
    $("#inventoryCount").textContent = state.toys.length;
    $("#inventoryUnits").textContent = units;
    $("#inventoryAverage").textContent = formatMoney(average);
    $("#toyGrid").innerHTML = toys.length ? toys.map(toy => `<article class="toy-card">
      <div class="toy-photo">${toy.image ? `<img src="${toy.image}" alt="${escapeHTML(toy.name)}">` : `<div class="toy-no-photo">OBA OBA</div>`}<span class="stock-badge ${toy.stock ? "" : "out"}">${toy.stock ? `${toy.stock} em estoque` : "Sem estoque"}</span></div>
      <div class="toy-card-body"><span class="toy-category">${escapeHTML(toy.category)}</span><h3>${escapeHTML(toy.name)}</h3><p>${escapeHTML(toy.description)}</p>
        <div class="toy-card-foot"><span class="toy-price"><strong>${formatMoney(toy.price)}</strong><small>por diária</small></span><span class="toy-actions"><button data-edit-toy="${toy.id}" title="Editar">✎</button><button data-delete-toy="${toy.id}" title="Excluir">×</button></span></div>
      </div>
    </article>`).join("") : emptyState("☆", term ? "Nenhum resultado encontrado" : "Seu catálogo está vazio", term ? "Tente buscar por outro nome ou categoria." : "Cadastre o primeiro brinquedo para começar a criar orçamentos.", term ? "" : "Cadastrar brinquedo", "new-toy");
  }

  function deleteToy(id) {
    const toy = state.toys.find(item => item.id === id);
    if (!toy || !confirm(`Excluir “${toy.name}” do catálogo? Os orçamentos já criados não serão alterados.`)) return;
    state.toys = state.toys.filter(item => item.id !== id);
    saveState();
    renderToys();
    renderDashboard();
    toast("Brinquedo excluído.");
  }

  function quotesForClient(client) {
    return state.quotes.filter(quote => quote.clientId === client.id || (!quote.clientId && quote.clientName?.toLocaleLowerCase("pt-BR") === client.name.toLocaleLowerCase("pt-BR") && (!quote.clientPhone || quote.clientPhone === client.phone)));
  }

  function addressesForClient(client) {
    if (Array.isArray(client?.addresses) && client.addresses.length) {
      return client.addresses.map((item, index) => ({ id: item.id || `address_${index}`, label: item.label || `Endereço ${index + 1}`, address: item.address || "" })).filter(item => item.address);
    }
    return client?.address ? [{ id: "legacy_primary", label: "Endereço principal", address: client.address }] : [];
  }

  function renderClientAddressRows(addresses = []) {
    const list = $("#clientAddressList");
    list.innerHTML = addresses.length ? addresses.map(item => `<div class="client-address-row" data-address-id="${escapeHTML(item.id || uid("address"))}"><input class="address-label" value="${escapeHTML(item.label || "")}" placeholder="Nome do local"><input class="address-value" value="${escapeHTML(item.address || "")}" placeholder="Rua, número, bairro, cidade e CEP"><button type="button" class="remove-address" data-remove-address aria-label="Remover endereço">×</button></div>`).join("") : `<div class="address-empty-note">Nenhum endereço adicionado.</div>`;
  }

  function addClientAddressRow(address = null) {
    const list = $("#clientAddressList");
    $(".address-empty-note", list)?.remove();
    const row = document.createElement("div");
    row.className = "client-address-row";
    row.dataset.addressId = address?.id || uid("address");
    row.innerHTML = `<input class="address-label" value="${escapeHTML(address?.label || "")}" placeholder="Nome do local"><input class="address-value" value="${escapeHTML(address?.address || "")}" placeholder="Rua, número, bairro, cidade e CEP"><button type="button" class="remove-address" data-remove-address aria-label="Remover endereço">×</button>`;
    list.appendChild(row);
    $(".address-label", row).focus();
  }

  function openClientForm(client = null, context = "clients") {
    clientFormContext = context;
    $("#clientForm").reset();
    $("#clientId").value = client?.id || "";
    $("#clientFormName").value = client?.name || "";
    $("#clientFormPhone").value = client?.phone || "";
    $("#clientEmail").value = client?.email || "";
    $("#clientDocument").value = client?.document || "";
    $("#clientNotes").value = client?.notes || "";
    renderClientAddressRows(client ? addressesForClient(client) : [{ id: uid("address"), label: "Principal", address: "" }]);
    $("#clientModalTitle").textContent = client ? "Editar cliente" : "Cadastrar cliente";
    openModal("clientModal");
    setTimeout(() => $("#clientFormName").focus(), 120);
  }

  function saveClient(event) {
    event.preventDefault();
    const id = $("#clientId").value;
    const phone = $("#clientFormPhone").value.trim();
    const duplicate = state.clients.find(client => client.id !== id && client.phone && client.phone.replace(/\D/g, "") === phone.replace(/\D/g, ""));
    if (duplicate && !confirm(`O telefone informado já pertence a “${duplicate.name}”. Deseja salvar mesmo assim?`)) return;
    const existing = state.clients.find(client => client.id === id);
    const addresses = $$(".client-address-row", $("#clientAddressList")).map((row, index) => ({
      id: row.dataset.addressId || uid("address"),
      label: $(".address-label", row).value.trim() || `Endereço ${index + 1}`,
      address: $(".address-value", row).value.trim()
    })).filter(item => item.address);
    const client = {
      id: id || uid("client"),
      name: $("#clientFormName").value.trim(),
      phone,
      email: $("#clientEmail").value.trim(),
      document: $("#clientDocument").value.trim(),
      addresses,
      address: addresses[0]?.address || "",
      notes: $("#clientNotes").value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (id) state.clients = state.clients.map(item => item.id === id ? client : item);
    else state.clients.unshift(client);
    saveState();
    closeModal("clientModal");
    renderClients();
    if (clientFormContext === "quote") {
      renderQuoteClientOptions(client.id);
      selectQuoteClient(client.id, true);
    }
    if (profileClientId === client.id && $("#clientProfileModal").classList.contains("is-open")) openClientProfile(client.id);
    toast(id ? "Cadastro do cliente atualizado." : "Cliente cadastrado com sucesso.");
  }

  function renderClients() {
    const term = $("#clientSearch").value.trim().toLocaleLowerCase("pt-BR");
    const clients = state.clients.filter(client => `${client.name} ${client.phone} ${client.email} ${client.document}`.toLocaleLowerCase("pt-BR").includes(term));
    const clientsWithEvents = state.clients.filter(client => quotesForClient(client).some(quote => quote.status === "approved")).length;
    const quoteValue = state.clients.reduce((sum, client) => sum + quotesForClient(client).reduce((clientSum, quote) => clientSum + Number(quote.total || 0), 0), 0);
    $("#clientTotal").textContent = state.clients.length;
    $("#clientWithEvents").textContent = clientsWithEvents;
    $("#clientQuoteValue").textContent = formatMoney(quoteValue);
    $("#clientGrid").innerHTML = clients.length ? clients.map(client => {
      const history = quotesForClient(client);
      const lastQuote = [...history].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
      return `<article class="client-card">
        <div class="client-card-head"><span class="client-avatar medium">${escapeHTML(client.name.charAt(0) || "?")}</span><span class="client-card-title"><strong>${escapeHTML(client.name)}</strong><small>Cliente desde ${new Date(client.createdAt).toLocaleDateString("pt-BR", { month: "short", year: "numeric" })}</small></span><span class="client-card-actions"><button data-edit-client="${client.id}" title="Editar">✎</button><button data-delete-client="${client.id}" title="Excluir">×</button></span></div>
        <div class="client-card-contact"><span><b>◉</b>${escapeHTML(client.phone)}</span><span><b>✉</b>${escapeHTML(client.email || "E-mail não informado")}</span></div>
        <div class="client-card-foot"><p><strong>${history.length} ${history.length === 1 ? "orçamento" : "orçamentos"}</strong><small>${lastQuote ? `Último em ${new Date(lastQuote.updatedAt).toLocaleDateString("pt-BR")}` : "Nenhum histórico ainda"}</small></p><button class="text-button" data-view-client="${client.id}">Ver perfil →</button></div>
      </article>`;
    }).join("") : emptyState("●", term ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado", term ? "Tente buscar por outro nome, telefone ou documento." : "Cadastre clientes para selecioná-los ao criar um orçamento.", term ? "" : "Cadastrar cliente", "new-client");
  }

  function deleteClient(id) {
    const client = state.clients.find(item => item.id === id);
    if (!client) return;
    const history = quotesForClient(client);
    const warning = history.length ? ` Este cliente possui ${history.length} orçamento(s); eles continuarão salvos, mas ficarão sem vínculo com um perfil.` : "";
    if (!confirm(`Excluir o cadastro de “${client.name}”?${warning}`)) return;
    state.clients = state.clients.filter(item => item.id !== id);
    state.quotes = state.quotes.map(quote => quote.clientId === id ? { ...quote, clientId: "" } : quote);
    saveState();
    renderClients();
    renderQuotes();
    toast("Cadastro do cliente excluído.");
  }

  function openClientProfile(id) {
    const client = state.clients.find(item => item.id === id);
    if (!client) return;
    profileClientId = id;
    const history = quotesForClient(client).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const approved = history.filter(quote => quote.status === "approved");
    $("#profileAvatar").textContent = client.name.charAt(0) || "?";
    $("#clientProfileName").textContent = client.name;
    $("#clientProfileSince").textContent = `Cliente desde ${new Date(client.createdAt).toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`;
    const addressCards = addressesForClient(client).length ? addressesForClient(client).map(item => `<div class="profile-contact-item"><span>⌂</span><p><small>${escapeHTML(item.label)}</small><strong>${escapeHTML(item.address)}</strong></p></div>`).join("") : `<div class="profile-contact-item"><span>⌂</span><p><small>Endereços</small><strong>Não informado</strong></p></div>`;
    $("#profileContacts").innerHTML = `<div class="profile-contact-item"><span>◉</span><p><small>WhatsApp</small><strong>${escapeHTML(client.phone)}</strong></p></div><div class="profile-contact-item"><span>✉</span><p><small>E-mail</small><strong>${escapeHTML(client.email || "Não informado")}</strong></p></div><div class="profile-contact-item"><span>▣</span><p><small>CPF/CNPJ</small><strong>${escapeHTML(client.document || "Não informado")}</strong></p></div>${addressCards}${client.notes ? `<div class="profile-contact-item full"><span>✎</span><p><small>Observações</small><strong>${escapeHTML(client.notes)}</strong></p></div>` : ""}`;
    $("#profileQuoteCount").textContent = history.length;
    $("#profileApprovedCount").textContent = approved.length;
    $("#profileApprovedValue").textContent = formatMoney(approved.reduce((sum, quote) => sum + Number(quote.total || 0), 0));
    $("#clientQuoteHistory").innerHTML = history.length ? history.map(quote => `<button class="history-row" data-edit-quote="${quote.id}"><span><strong>${escapeHTML(quote.number)}</strong><small>${new Date(quote.createdAt).toLocaleDateString("pt-BR")}</small></span><span><strong>${formatDate(quote.eventDate)}</strong><small>${escapeHTML(quote.startTime || "—")}–${escapeHTML(quote.endTime || "—")}</small></span><span class="money">${formatMoney(quote.total)}</span>${statusBadge(quote.status)}<i class="history-open">→</i></button>`).join("") : `<div class="empty-state"><div><span class="empty-icon">◇</span><strong>Nenhum orçamento</strong><p>Crie o primeiro orçamento para este cliente.</p></div></div>`;
    openModal("clientProfileModal");
  }

  function nextQuoteNumber() {
    const max = state.quotes.reduce((highest, quote) => Math.max(highest, Number(String(quote.number || "").replace(/\D/g, "")) || 0), 0);
    return `OB-${String(max + 1).padStart(4, "0")}`;
  }

  function openQuoteForm(quote = null, preselectedClientId = "") {
    $("#quoteForm").reset();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const validity = new Date();
    validity.setDate(validity.getDate() + 7);
    $("#quoteId").value = quote?.id || "";
    $("#clientName").value = quote?.clientName || "";
    $("#clientPhone").value = quote?.clientPhone || "";
    $("#eventAddress").value = quote?.eventAddress || "";
    $("#selectedEventAddress").value = quote?.eventAddress || "";
    $("#eventDate").value = quote?.eventDate || toISODate(tomorrow);
    $("#startTime").value = quote?.startTime || "13:00";
    $("#endTime").value = quote?.endTime || "17:00";
    $("#depositPercent").value = quote?.depositPercent ?? 50;
    $("#quoteValidity").value = quote?.validity || toISODate(validity);
    $("#quoteNotes").value = quote?.notes || "";
    quoteItems = quote?.items ? structuredClone(quote.items) : [];
    $("#quoteNumberLabel").textContent = quote?.number || nextQuoteNumber();
    $("#quoteModalTitle").textContent = quote ? "Editar orçamento" : "Montar orçamento";
    $("#approveQuoteButton").textContent = quote?.status === "approved" ? "Salvar evento" : "Aprovar e agendar";
    $("#saveDraftButton").textContent = quote?.status === "approved" ? "Salvar alterações" : "Salvar rascunho";
    const matchedClient = quote?.clientId || state.clients.find(client => client.name === quote?.clientName && (!quote?.clientPhone || client.phone === quote.clientPhone))?.id || preselectedClientId;
    renderQuoteClientOptions(matchedClient);
    selectQuoteClient(matchedClient, !quote, !!quote, quote?.eventAddressId || "", quote?.eventAddress || "");
    renderQuoteToyPicker();
    renderSelectedItems();
    updateQuotePreview();
    openModal("quoteModal");
  }

  function renderQuoteClientOptions(selectedId = "") {
    const select = $("#quoteClientSelect");
    select.innerHTML = `<option value="">Selecione um cliente...</option>${[...state.clients].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map(client => `<option value="${client.id}">${escapeHTML(client.name)} — ${escapeHTML(client.phone)}</option>`).join("")}`;
    select.value = selectedId || "";
  }

  function selectQuoteClient(id, fillAddress = true, keepLegacySnapshot = false, selectedAddressId = "", selectedAddressText = "") {
    const client = state.clients.find(item => item.id === id);
    $("#quoteClientSelect").value = client?.id || "";
    if (!client) {
      if (!keepLegacySnapshot) {
        $("#clientName").value = "";
        $("#clientPhone").value = "";
      }
      const legacyName = $("#clientName").value;
      $("#selectedClientSummary").innerHTML = `<span class="client-avatar small">${escapeHTML((legacyName || "?").charAt(0))}</span><p><strong>${escapeHTML(legacyName || "Nenhum cliente selecionado")}</strong><small>${legacyName ? "Orçamento antigo sem vínculo com cadastro" : "Escolha um cadastro para preencher o orçamento."}</small></p>`;
      renderEventAddressOptions(null, "", selectedAddressText, false);
      updateQuotePreview();
      return;
    }
    $("#clientName").value = client.name;
    $("#clientPhone").value = client.phone;
    $("#selectedClientSummary").innerHTML = `<span class="client-avatar small">${escapeHTML(client.name.charAt(0))}</span><p><strong>${escapeHTML(client.name)}</strong><small>${escapeHTML(client.phone)}${client.email ? ` • ${escapeHTML(client.email)}` : ""}</small></p>`;
    renderEventAddressOptions(client, selectedAddressId, selectedAddressText, fillAddress);
    updateQuotePreview();
  }

  function renderEventAddressOptions(client, selectedId = "", selectedText = "", preferFirst = true) {
    const select = $("#eventAddressSelect");
    const addresses = addressesForClient(client);
    if (!client) {
      select.innerHTML = `<option value="">Selecione primeiro um cliente...</option>`;
      select.disabled = true;
      $("#customAddressField").hidden = true;
      $("#selectedEventAddress").value = selectedText || "";
      return;
    }
    select.disabled = false;
    select.innerHTML = `<option value="">Selecione um endereço...</option>${addresses.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.label)} — ${escapeHTML(item.address)}</option>`).join("")}<option value="__custom">Usar outro endereço...</option>`;
    const matching = addresses.find(item => item.id === selectedId || (selectedText && item.address === selectedText));
    if (matching) select.value = matching.id;
    else if (selectedText) select.value = "__custom";
    else if (preferFirst && addresses[0]) select.value = addresses[0].id;
    else select.value = "";
    syncEventAddress();
    if (selectedText && select.value === "__custom") {
      $("#eventAddress").value = selectedText;
      $("#selectedEventAddress").value = selectedText;
    }
  }

  function syncEventAddress() {
    const client = state.clients.find(item => item.id === $("#quoteClientSelect").value);
    const choice = $("#eventAddressSelect").value;
    const custom = choice === "__custom";
    $("#customAddressField").hidden = !custom;
    if (custom) $("#selectedEventAddress").value = $("#eventAddress").value.trim();
    else $("#selectedEventAddress").value = addressesForClient(client).find(item => item.id === choice)?.address || "";
    updateQuotePreview();
  }

  function renderQuoteToyPicker() {
    const container = $("#quoteToyPicker");
    container.innerHTML = state.toys.length ? state.toys.map(toy => {
      const selected = quoteItems.some(item => item.toyId === toy.id);
      return `<button type="button" class="picker-toy" data-add-toy="${toy.id}" ${selected || toy.stock <= 0 ? "disabled" : ""}>
        ${toy.image ? `<img src="${toy.image}" alt="">` : `<span class="picker-placeholder">★</span>`}
        <span><strong>${escapeHTML(toy.name)}</strong><small>${formatMoney(toy.price)} • ${toy.stock} un.</small></span><b>＋</b>
      </button>`;
    }).join("") : `<div class="empty-state" style="grid-column:1/-1;min-height:120px"><div><strong>Nenhum brinquedo cadastrado</strong><p>Salve este orçamento como rascunho e cadastre seu catálogo.</p></div></div>`;
  }

  function addQuoteItem(toyId) {
    const toy = state.toys.find(item => item.id === toyId);
    if (!toy || quoteItems.some(item => item.toyId === toyId)) return;
    quoteItems.push({ toyId: toy.id, name: toy.name, image: toy.image, description: toy.description, qty: 1, unitPrice: Number(toy.price), stock: Number(toy.stock) });
    renderQuoteToyPicker();
    renderSelectedItems();
    updateQuotePreview();
  }

  function renderSelectedItems() {
    $("#selectedQuoteItems").innerHTML = quoteItems.length ? quoteItems.map(item => `<div class="selected-item" data-selected-item="${item.toyId}">
      <div><strong>${escapeHTML(item.name)}</strong><small>Máx. ${item.stock ?? "—"} por evento</small></div>
      <div class="qty-control"><button type="button" data-qty-change="-1">−</button><input type="number" min="1" max="${item.stock || 999}" value="${item.qty}" aria-label="Quantidade"><button type="button" data-qty-change="1">＋</button></div>
      <span class="item-unit-price">${formatMoney(Number(item.unitPrice) * Number(item.qty))}</span>
      <button type="button" class="remove-item" data-remove-item="${item.toyId}" aria-label="Remover">×</button>
    </div>`).join("") : "";
  }

  function readQuoteForm() {
    const existing = state.quotes.find(q => q.id === $("#quoteId").value);
    const total = quoteItems.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.qty), 0);
    return {
      id: existing?.id || uid("quote"),
      number: existing?.number || $("#quoteNumberLabel").textContent,
      clientId: $("#quoteClientSelect").value,
      clientName: $("#clientName").value.trim(),
      clientPhone: $("#clientPhone").value.trim(),
      eventAddressId: $("#eventAddressSelect").value === "__custom" ? "" : $("#eventAddressSelect").value,
      eventAddress: $("#selectedEventAddress").value.trim(),
      eventDate: $("#eventDate").value,
      startTime: $("#startTime").value,
      endTime: $("#endTime").value,
      depositPercent: Math.min(100, Math.max(0, Number($("#depositPercent").value) || 0)),
      validity: $("#quoteValidity").value,
      notes: $("#quoteNotes").value.trim(),
      items: structuredClone(quoteItems),
      total,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: existing?.status || "draft"
    };
  }

  function validateForApproval(quote) {
    if (!quote.clientId) return "Selecione um cliente cadastrado.";
    if (!quote.clientName) return "Informe o nome do cliente.";
    if (!quote.eventAddress) return "Selecione ou informe o endereço do evento.";
    if (!quote.eventDate) return "Escolha a data do evento.";
    if (!quote.startTime || !quote.endTime) return "Informe o horário do evento.";
    if (quote.endTime <= quote.startTime) return "O horário de término deve ser depois do início.";
    if (!quote.items.length) return "Adicione pelo menos um brinquedo.";
    for (const item of quote.items) {
      const toy = state.toys.find(t => t.id === item.toyId);
      if (!toy) continue;
      const alreadyReserved = state.quotes
        .filter(q => q.status === "approved" && q.eventDate === quote.eventDate && q.id !== quote.id)
        .flatMap(q => q.items)
        .filter(qItem => qItem.toyId === item.toyId)
        .reduce((sum, qItem) => sum + Number(qItem.qty), 0);
      if (alreadyReserved + Number(item.qty) > Number(toy.stock)) {
        return `Estoque insuficiente de “${toy.name}” nessa data. Disponível: ${Math.max(0, toy.stock - alreadyReserved)}.`;
      }
    }
    return "";
  }

  function saveQuote(status) {
    const quote = readQuoteForm();
    const existing = state.quotes.find(q => q.id === quote.id);
    const effectiveStatus = existing?.status === "approved" && status === "draft" ? "approved" : status;
    if (effectiveStatus === "approved") {
      const error = validateForApproval(quote);
      if (error) { toast(error, "error"); return; }
    }
    quote.status = effectiveStatus;
    const index = state.quotes.findIndex(q => q.id === quote.id);
    if (index >= 0) state.quotes[index] = quote;
    else state.quotes.unshift(quote);
    saveState();
    closeModal("quoteModal");
    renderDashboard();
    renderQuotes();
    renderCalendar();
    toast(effectiveStatus === "approved" ? "Orçamento aprovado e evento adicionado à agenda." : "Rascunho salvo com sucesso.");
  }

  function updateQuotePreview() {
    const data = readQuoteForm();
    const total = data.total;
    const deposit = total * data.depositPercent / 100;
    $("#previewClient").textContent = data.clientName || "NOME DO CLIENTE";
    $("#previewThanksName").textContent = (data.clientName || "CLIENTE").split(" ")[0].toUpperCase();
    $("#previewDate").textContent = formatDate(data.eventDate);
    $("#previewTime").textContent = data.startTime && data.endTime ? `${data.startTime} ÀS ${data.endTime}` : "—";
    $("#previewAddressWrap").hidden = !data.eventAddress;
    $("#previewAddress").textContent = data.eventAddress;
    $("#previewTotal").textContent = formatMoney(total);
    $("#previewDeposit").textContent = formatMoney(deposit);
    $("#previewBalance").textContent = formatMoney(total - deposit);
    $("#previewNotesWrap").hidden = !data.notes;
    $("#previewNotes").textContent = data.notes;
    $("#previewBusinessPhone").textContent = state.settings.phone;
    $("#previewInstagram").textContent = state.settings.instagram;
    $("#previewItems").innerHTML = quoteItems.length ? quoteItems.map(item => `<div class="sheet-item">
      <div class="sheet-item-photo">${item.image ? `<img src="${item.image}" alt="">` : `<div class="sheet-photo-placeholder">FOTO DO BRINQUEDO</div>`}</div>
      <div class="sheet-item-desc"><strong>${escapeHTML(item.name)}</strong><b>${item.qty} ${item.qty === 1 ? "UNIDADE" : "UNIDADES"}</b><p>${escapeHTML(item.description || "Diversão garantida com segurança e qualidade.")}</p></div>
      <div class="sheet-item-price">${formatMoney(Number(item.unitPrice) * Number(item.qty))}</div>
    </div>`).join("") : `<div class="sheet-empty-items">Selecione os brinquedos<br>para montar o orçamento.</div>`;
  }

  function renderQuotes() {
    const term = $("#quoteSearch").value.trim().toLocaleLowerCase("pt-BR");
    const counts = {
      all: state.quotes.length,
      draft: state.quotes.filter(q => q.status === "draft").length,
      pending: state.quotes.filter(q => q.status === "pending").length,
      approved: state.quotes.filter(q => q.status === "approved").length
    };
    Object.entries(counts).forEach(([key, value]) => $(`#count${key.charAt(0).toUpperCase() + key.slice(1)}`).textContent = value);
    const quotes = [...state.quotes]
      .filter(q => quoteFilter === "all" || q.status === quoteFilter)
      .filter(q => `${q.clientName} ${q.number}`.toLocaleLowerCase("pt-BR").includes(term))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    $("#quotesList").innerHTML = quotes.length ? quotes.map(q => `<div class="quote-row" data-edit-quote="${q.id}">
      <span><strong>${escapeHTML(q.number)}</strong><small>Criado em ${new Date(q.createdAt).toLocaleDateString("pt-BR")}</small></span>
      <span><strong>${escapeHTML(q.clientName || "Cliente não informado")}</strong><small>${escapeHTML(q.clientPhone || "Sem contato")}</small></span>
      <span><strong>${formatDate(q.eventDate)}</strong><small>${escapeHTML(q.startTime || "—")}–${escapeHTML(q.endTime || "—")}</small></span>
      <span class="money">${formatMoney(q.total)}</span>
      ${statusBadge(q.status)}
      <button class="row-menu" data-quote-menu="${q.id}" aria-label="Ações">•••</button>
    </div>`).join("") : emptyState("◇", "Nenhum orçamento encontrado", term || quoteFilter !== "all" ? "Ajuste os filtros para ver outros resultados." : "Crie sua primeira proposta profissional.", term || quoteFilter !== "all" ? "" : "Novo orçamento", "new-quote");
  }

  function openQuoteActions(id, anchor) {
    $(".context-menu")?.remove();
    const quote = state.quotes.find(q => q.id === id);
    if (!quote) return;
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.innerHTML = `<button data-menu-action="edit">Editar orçamento</button>${quote.status === "draft" ? `<button data-menu-action="pending">Marcar como enviado</button>` : ""}${quote.status !== "approved" ? `<button data-menu-action="approve">Aprovar e agendar</button>` : ""}<button class="danger" data-menu-action="delete">Excluir orçamento</button>`;
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 10)}px`;
    menu.style.left = `${Math.max(10, rect.right - menu.offsetWidth)}px`;
    menu.addEventListener("click", event => {
      const action = event.target.dataset.menuAction;
      if (!action) return;
      menu.remove();
      if (action === "edit") openQuoteForm(quote);
      if (action === "pending") changeQuoteStatus(quote, "pending");
      if (action === "approve") {
        const error = validateForApproval(quote);
        if (error) { toast(error, "error"); openQuoteForm(quote); }
        else changeQuoteStatus(quote, "approved");
      }
      if (action === "delete") deleteQuote(quote);
    });
    setTimeout(() => document.addEventListener("click", function close(event) { if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener("click", close); } }), 0);
  }

  function changeQuoteStatus(quote, status) {
    quote.status = status;
    quote.updatedAt = new Date().toISOString();
    saveState();
    renderQuotes();
    renderDashboard();
    renderCalendar();
    toast(status === "approved" ? "Orçamento aprovado e evento agendado." : "Orçamento marcado como enviado.");
  }

  function deleteQuote(quote) {
    if (!confirm(`Excluir o orçamento ${quote.number} de ${quote.clientName || "cliente não informado"}?`)) return;
    state.quotes = state.quotes.filter(q => q.id !== quote.id);
    saveState();
    renderQuotes();
    renderDashboard();
    renderCalendar();
    toast("Orçamento excluído.");
  }

  function renderCalendar() {
    $("#calendarMonth").textContent = monthLong.format(calendarCursor);
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - first.getDay());
    const today = toISODate(new Date());
    const days = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      const iso = toISODate(date);
      const events = state.quotes.filter(q => q.status === "approved" && q.eventDate === iso).sort((a, b) => a.startTime.localeCompare(b.startTime));
      days.push(`<button class="calendar-day ${date.getMonth() !== month ? "other-month" : ""} ${iso === today ? "today" : ""} ${iso === selectedCalendarDate ? "selected" : ""}" data-calendar-date="${iso}">
        <span class="day-number">${date.getDate()}</span>
        ${events.slice(0, 2).map((event, index) => `<span class="calendar-event-chip ${events.length > 1 && index > 0 ? "busy" : ""}">${escapeHTML(event.startTime)} ${escapeHTML(event.clientName)}</span>`).join("")}
        ${events.length > 2 ? `<span class="more-events">+${events.length - 2} evento(s)</span>` : ""}
      </button>`);
    }
    $("#calendarGrid").innerHTML = days.join("");
    renderSelectedDay();
  }

  function renderSelectedDay() {
    const date = parseISODate(selectedCalendarDate);
    $("#selectedDayTitle").textContent = date ? dateLong.format(date) : "Selecione uma data";
    const events = state.quotes.filter(q => q.status === "approved" && q.eventDate === selectedCalendarDate).sort((a, b) => a.startTime.localeCompare(b.startTime));
    $("#selectedDayEvents").innerHTML = events.length ? events.map(event => `<button class="day-event-card" data-edit-quote="${event.id}">
      <time>${escapeHTML(event.startTime)} — ${escapeHTML(event.endTime)}</time><strong>${escapeHTML(event.clientName)}</strong><small>${event.items.map(item => `${item.qty}× ${escapeHTML(item.name)}`).join(" • ")}</small><small>${escapeHTML(event.eventAddress || "Local não informado")}</small>
    </button>`).join("") : `<div class="empty-state"><div><span class="empty-icon">○</span><strong>Dia livre</strong><p>Não há eventos aprovados nesta data.</p></div></div>`;
  }

  function saveSettings(event) {
    event.preventDefault();
    state.settings.phone = $("#businessPhone").value.trim() || defaultState.settings.phone;
    state.settings.instagram = $("#businessInstagram").value.trim() || defaultState.settings.instagram;
    saveState();
    closeModal("settingsModal");
    updateQuotePreview();
    toast("Dados da empresa atualizados.");
  }

  function initEvents() {
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-section], [data-go]");
      if (nav) navigate(nav.dataset.section || nav.dataset.go);

      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "new-toy") openToyForm();
      if (action === "new-client") openClientForm();
      if (action === "quick-client") openClientForm(null, "quote");
      if (action === "new-quote") openQuoteForm();
      if (action === "logout") void logout();
      if (action === "open-settings") {
        $("#businessPhone").value = state.settings.phone;
        $("#businessInstagram").value = state.settings.instagram;
        openModal("settingsModal");
      }

      if (event.target.closest("[data-close-modal]")) closeModal(event.target);
      const editToyId = event.target.closest("[data-edit-toy]")?.dataset.editToy;
      if (editToyId) openToyForm(state.toys.find(toy => toy.id === editToyId));
      const deleteToyId = event.target.closest("[data-delete-toy]")?.dataset.deleteToy;
      if (deleteToyId) deleteToy(deleteToyId);
      const editClientId = event.target.closest("[data-edit-client]")?.dataset.editClient;
      if (editClientId) openClientForm(state.clients.find(client => client.id === editClientId));
      const deleteClientId = event.target.closest("[data-delete-client]")?.dataset.deleteClient;
      if (deleteClientId) deleteClient(deleteClientId);
      const viewClientId = event.target.closest("[data-view-client]")?.dataset.viewClient;
      if (viewClientId) openClientProfile(viewClientId);
      const removeAddress = event.target.closest("[data-remove-address]");
      if (removeAddress) {
        removeAddress.closest(".client-address-row").remove();
        if (!$(".client-address-row", $("#clientAddressList"))) renderClientAddressRows([]);
      }
      const addToyId = event.target.closest("[data-add-toy]")?.dataset.addToy;
      if (addToyId) addQuoteItem(addToyId);
      const removeItemId = event.target.closest("[data-remove-item]")?.dataset.removeItem;
      if (removeItemId) {
        quoteItems = quoteItems.filter(item => item.toyId !== removeItemId);
        renderQuoteToyPicker(); renderSelectedItems(); updateQuotePreview();
      }
      const qtyButton = event.target.closest("[data-qty-change]");
      if (qtyButton) {
        const row = qtyButton.closest("[data-selected-item]");
        const item = quoteItems.find(i => i.toyId === row.dataset.selectedItem);
        item.qty = Math.max(1, Math.min(item.stock || 999, Number(item.qty) + Number(qtyButton.dataset.qtyChange)));
        renderSelectedItems(); updateQuotePreview();
      }
      const editQuote = event.target.closest("[data-edit-quote]");
      if (editQuote && !event.target.closest("[data-quote-menu]")) openQuoteForm(state.quotes.find(q => q.id === editQuote.dataset.editQuote));
      const quoteMenu = event.target.closest("[data-quote-menu]");
      if (quoteMenu) { event.stopPropagation(); openQuoteActions(quoteMenu.dataset.quoteMenu, quoteMenu); }
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (calendarDay) { selectedCalendarDate = calendarDay.dataset.calendarDate; renderCalendar(); }
      const editorTitle = event.target.closest(".editor-title");
      if (editorTitle) editorTitle.closest(".editor-section").classList.toggle("open");
    });

    $$(".modal").forEach(modal => modal.addEventListener("keydown", event => { if (event.key === "Escape") closeModal(modal); }));
    $("#toyForm").addEventListener("submit", saveToy);
    $("#clientForm").addEventListener("submit", saveClient);
    $("#settingsForm").addEventListener("submit", saveSettings);
    $("#toySearch").addEventListener("input", renderToys);
    $("#clientSearch").addEventListener("input", renderClients);
    $("#quoteSearch").addEventListener("input", renderQuotes);
    $$(".filter-tab").forEach(tab => tab.addEventListener("click", () => {
      quoteFilter = tab.dataset.filter;
      $$(".filter-tab").forEach(item => item.classList.toggle("active", item === tab));
      renderQuotes();
    }));

    $("#toyUploadBox").addEventListener("click", event => { if (!event.target.closest("#changePhoto")) $("#toyImage").click(); });
    $("#changePhoto").addEventListener("click", () => $("#toyImage").click());
    $("#toyImage").addEventListener("change", async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) { toast("Selecione um arquivo de imagem.", "error"); return; }
      editingToyImage = await compressImage(file);
      updateToyImagePreview();
    });

    $$("#quoteForm input, #quoteForm textarea").forEach(input => input.addEventListener("input", updateQuotePreview));
    $("#quoteClientSelect").addEventListener("change", event => selectQuoteClient(event.target.value, true));
    $("#eventAddressSelect").addEventListener("change", syncEventAddress);
    $("#eventAddress").addEventListener("input", syncEventAddress);
    $("#selectedQuoteItems").addEventListener("change", event => {
      if (event.target.type !== "number") return;
      const row = event.target.closest("[data-selected-item]");
      const item = quoteItems.find(i => i.toyId === row.dataset.selectedItem);
      item.qty = Math.max(1, Math.min(item.stock || 999, Number(event.target.value) || 1));
      renderSelectedItems(); updateQuotePreview();
    });
    $("#saveDraftButton").addEventListener("click", () => saveQuote("draft"));
    $("#approveQuoteButton").addEventListener("click", () => saveQuote("approved"));
    $("#printQuoteButton").addEventListener("click", () => window.print());

    $("#prevMonth").addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1); renderCalendar(); });
    $("#nextMonth").addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1); renderCalendar(); });
    $("#todayButton").addEventListener("click", () => { calendarCursor = startOfMonth(new Date()); selectedCalendarDate = toISODate(new Date()); renderCalendar(); });
    $("#addClientAddress").addEventListener("click", () => addClientAddressRow());
    $("#profileEditClient").addEventListener("click", () => openClientForm(state.clients.find(client => client.id === profileClientId)));
    $("#profileNewQuote").addEventListener("click", () => openQuoteForm(null, profileClientId));
  }

  async function startApp() {
    showApp();
    $("#todayText").textContent = dateLong.format(new Date());
    if (!await hydrateState()) return;
    if (!appEventsInitialized) {
      initEvents();
      appEventsInitialized = true;
    }
    renderDashboard();
    renderToys();
    renderClients();
    renderQuotes();
    renderCalendar();
    const requested = location.hash.replace("#", "");
    navigate(pageInfo[requested] ? requested : requested === "new-quote" ? "quotes" : requested === "new-toy" ? "toys" : requested === "new-client" ? "clients" : "dashboard");
    if (requested === "new-quote") openQuoteForm();
    if (requested === "new-toy") openToyForm();
    if (requested === "new-client") openClientForm();
  }

  async function init() {
    initAuthEvents();
    if (await checkSession()) await startApp();
    else showLogin();
  }

  void init();
})();
