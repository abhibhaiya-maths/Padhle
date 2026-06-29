/* ====================================================================
   CHATBOT — logic ported intact from the original build: same worker
   endpoint, same language/script detection, same KaTeX+Marked math
   rendering pipeline, same localStorage-based name/session memory.
   Only the markup class names it injects have been updated to match
   this project's BEM-ish naming (bubble-row/bubble-content) instead
   of the old Tailwind utility strings.
   ==================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const chatToggleBtn = document.getElementById('chat-toggle-btn');
  const chatWindow = document.getElementById('chat-window');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');
  const chatStream = document.getElementById('chat-stream');
  if (!chatToggleBtn || !chatWindow) return;

  const WORKER_URL = "https://padhleindia.raiabhinaykumar.workers.dev";
  let chatHistory = [];
  let isChatOpen = false;
  let isMaximized = false;

  const chatMaximizeBtn = document.getElementById('chat-maximize-btn');

  chatToggleBtn.addEventListener('click', () => {
    isChatOpen = !isChatOpen;
    isChatOpen ? openChatWindow() : closeChatWindow();
  });

  function openChatWindow() {
    isChatOpen = true;
    chatWindow.classList.add('is-open');
    hideTeaser();
    const glowRing = document.getElementById('chat-glow-ring');
    const badgeDot = document.getElementById('chat-badge-dot');
    if (glowRing) glowRing.style.display = 'none';
    if (badgeDot) badgeDot.style.display = 'none';
  }

  function closeChatWindow() {
    isChatOpen = false;
    chatWindow.classList.remove('is-open');
    isMaximized = false;
    chatWindow.classList.remove('is-maximized');
  }

  const chatTeaser = document.getElementById('chat-teaser');
  const chatTeaserClose = document.getElementById('chat-teaser-close');

  function hideTeaser() { if (chatTeaser) chatTeaser.classList.remove('is-visible'); }

  if (chatTeaser && !sessionStorage.getItem('chat_teaser_shown')) {
    setTimeout(() => {
      if (!isChatOpen) {
        chatTeaser.classList.add('is-visible');
        sessionStorage.setItem('chat_teaser_shown', '1');
      }
    }, 6000);
  }
  if (chatTeaser) {
    chatTeaser.addEventListener('click', (e) => {
      if (e.target === chatTeaserClose) return;
      hideTeaser();
      if (!isChatOpen) { isChatOpen = true; openChatWindow(); }
    });
  }
  if (chatTeaserClose) {
    chatTeaserClose.addEventListener('click', (e) => { e.stopPropagation(); hideTeaser(); });
  }

  if (chatMaximizeBtn) {
    chatMaximizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isMaximized = !isMaximized;
      chatWindow.classList.toggle('is-maximized', isMaximized);
      chatStream.scrollTop = chatStream.scrollHeight;
    });
  }

  function initializeWelcomeMessage() {
    const welcomeContainer = document.getElementById('welcome-content');
    if (!welcomeContainer) return;
    const savedName = localStorage.getItem('warrior_name');

    if (savedName) {
      welcomeContainer.innerHTML = `Hey <strong>${savedName} Warrior!</strong> Math ya science me koi concept pareshan kar raha hai? Mujhe batao, milkar solve karte hain! 🎯`;
    } else {
      welcomeContainer.innerHTML = `
        <div id="welcome-form-block">
          <p>Hey Warrior! Math ya science me koi concept pareshan kar raha hai? Sawaal puchne se pehle, apna naam batao bacha taaki bhaiya aapko naam se bula sakein: 🎯</p>
          <div class="welcome-form-row">
            <input type="text" id="warrior-name-input" placeholder="Type your name...">
            <button type="button" id="save-warrior-name-btn">Let's Study! 🚀</button>
          </div>
        </div>`;
      setTimeout(() => {
        const saveBtn = document.getElementById('save-warrior-name-btn');
        const nameInput = document.getElementById('warrior-name-input');
        if (saveBtn && nameInput) {
          saveBtn.addEventListener('click', () => {
            const nameVal = nameInput.value.trim();
            if (nameVal) {
              localStorage.setItem('warrior_name', nameVal);
              document.getElementById('welcome-form-block').innerHTML =
                `Hey <strong>${nameVal} Warrior!</strong> Math ya science me koi concept pareshan kar raha hai? Mujhe batao, milkar solve karte hain! 🎯`;
            } else {
              alert("Warrior, please enter your name first!");
            }
          });
        }
      }, 100);
    }
  }
  initializeWelcomeMessage();

  function detectScript(text) {
    return /[\u0900-\u097F]/.test(text) ? "Devanagari" : "Latin";
  }

  function detectLanguage(text, script) {
    if (script === "Devanagari") return "Hindi";
    const cleanText = text.toLowerCase().replace(/[^a-z\s]/g, " ").trim();
    const words = cleanText.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return "Hinglish";
    const hinglishStopwords = new Set([
      "kya", "kyu", "kyun", "kaise", "samjhao", "batao", "nikalo", "nikalte", "hota", "hoti",
      "hai", "hain", "ye", "yeh", "wo", "woh", "ko", "se", "me", "mein", "par", "aur", "hi",
      "toh", "to", "hum", "ham", "bhai", "bhaiya", "bol", "bole", "bata", "karo", "karna",
      "kar", "ki", "ka", "ke", "sahi", "galat", "hoga", "hogi", "nahi", "na", "mat", "lo", "le"
    ]);
    let hinglishWordCount = 0;
    words.forEach(word => { if (hinglishStopwords.has(word)) hinglishWordCount++; });
    return hinglishWordCount > 0 ? "Hinglish" : "English";
  }

  async function sendMessage() {
    const messageText = chatInput.value.trim();
    if (!messageText) return;
    chatInput.value = "";
    appendBubble("user", messageText);
    const loaderId = appendBubble("bot", "Abhi bhaiya soch rahe hain... ⚡", true);

    try {
      const savedName = localStorage.getItem('warrior_name') || "Warrior";
      const activeClass = window.activeTargetClass || "10";
      let sessionCount = parseInt(localStorage.getItem('session_count') || "1");
      localStorage.setItem('session_count', sessionCount + 1);
      const prevTopic = localStorage.getItem('last_discussed_topic') || "Introductory Concepts";
      localStorage.setItem('last_discussed_topic', messageText.substring(0, 30));

      const detectedScr = detectScript(messageText);
      const detectedLang = detectLanguage(messageText, detectedScr);
      const prevConvLang = localStorage.getItem('conversation_language') || "Hinglish";
      localStorage.setItem('conversation_language', detectedLang);

      const studentProfile = {
        name: savedName,
        class: activeClass === '10' ? "Class 10" : (activeClass === '9' ? "Class 9" : "Olympiad/JEE Foundation"),
        board: "CBSE",
        target: activeClass === '10' ? "95%+ in Board Exams 🎯" : "Olympiad Rank & Strong Foundation 🏆",
        languagePreference: localStorage.getItem('preferred_language') || "Auto",
        detectedLanguage: detectedLang,
        detectedScript: detectedScr,
        conversationLanguage: prevConvLang,
        weakTopics: activeClass === '10' ? ["Trigonometry Identities", "Quadratic Roots"] : ["Polynomials", "Number Systems"],
        recentMistakes: activeClass === '10' ? ["Formula signs", "Square roots calculation"] : ["Fraction divisions"],
        sessionNumber: sessionCount,
        previousTopic: prevTopic
      };

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messageText, history: chatHistory, student: studentProfile })
      });
      if (!response.ok) throw new Error(`Server returned status ${response.status}`);
      const data = await response.json();

      removeLoader(loaderId);
      appendBubble("bot", data.reply);

      chatHistory.push({ role: "user", parts: [{ text: messageText }] });
      chatHistory.push({ role: "model", parts: [{ text: data.reply }] });
      if (chatHistory.length > 20) chatHistory.shift();
    } catch (error) {
      console.error("Chat Error Details: ", error);
      removeLoader(loaderId);
      appendBubble("bot", "Lagta hai technical issues hain, dobara koshish karo Champion!");
    }
  }

  if (window.marked) marked.setOptions({ breaks: true, gfm: true });

  function renderMarkdownAndMath(text) {
    if (!window.katex || !window.marked) return text;
    const mathBlocks = [];
    let processedText = text;

    const cleanMath = (mathStr) => {
      let m = mathStr.trim();
      m = m.replace(/^([\^_])/, '{}$1');
      m = m.replace(/(\s)([\^_])/g, '$1{}$2');
      m = m.replace(/([\+\-\=\/\|\*\<\>])\s*([\^_])/g, '$1{}$2');
      m = m.replace(/(\\rightarrow|\\to|\\leftarrow|\\Rightarrow|\\Leftarrow|\\leftrightarrow|\\Leftrightarrow)\s*([\^_])/g, '$1{}$2');
      return m;
    };

    processedText = processedText.replace(/\\+begin\{([a-zA-Z\*]+)\}([\s\S]+?)\\+end\{\1\}/g, (match) => {
      const placeholder = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      try {
        const html = '<div class="katex-display">' + katex.renderToString(cleanMath(match), { displayMode: true, throwOnError: false }) + '</div>';
        mathBlocks.push({ placeholder, html });
        return placeholder;
      } catch (e) { return match; }
    });

    processedText = processedText.replace(/\\+\[([\s\S]+?)\\+\]/g, (match, math) => {
      const placeholder = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      try {
        const html = '<div class="katex-display">' + katex.renderToString(cleanMath(math), { displayMode: true, throwOnError: false }) + '</div>';
        mathBlocks.push({ placeholder, html });
        return placeholder;
      } catch (e) { return match; }
    });

    processedText = processedText.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
      const placeholder = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      try {
        const html = '<div class="katex-display">' + katex.renderToString(cleanMath(math), { displayMode: true, throwOnError: false }) + '</div>';
        mathBlocks.push({ placeholder, html });
        return placeholder;
      } catch (e) { return match; }
    });

    processedText = processedText.replace(/\\+\(([\s\S]+?)\\+\)/g, (match, math) => {
      const placeholder = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      try {
        const html = katex.renderToString(cleanMath(math), { displayMode: false, throwOnError: false });
        mathBlocks.push({ placeholder, html });
        return placeholder;
      } catch (e) { return match; }
    });

    processedText = processedText.replace(/\$([^\$\n]+?)\$/g, (match, math) => {
      const placeholder = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      try {
        const html = katex.renderToString(cleanMath(math), { displayMode: false, throwOnError: false });
        mathBlocks.push({ placeholder, html });
        return placeholder;
      } catch (e) { return match; }
    });

    let htmlResult = marked.parse(processedText);
    mathBlocks.forEach(({ placeholder, html }) => { htmlResult = htmlResult.replace(placeholder, html); });
    return htmlResult;
  }

  function appendBubble(role, text, isLoading = false) {
    const bubbleId = 'bubble-' + Date.now();
    const bubbleWrapper = document.createElement('div');

    if (role === 'user') {
      bubbleWrapper.className = "bubble-row user";
      bubbleWrapper.innerHTML = `<div class="bubble-content">${text}</div>`;
    } else {
      bubbleWrapper.id = bubbleId;
      bubbleWrapper.className = "bubble-row bot";
      let contentHTML = text;
      if (!isLoading) contentHTML = renderMarkdownAndMath(text);
      bubbleWrapper.innerHTML = `
        <div class="bubble-avatar">🎓</div>
        <div class="bubble-content">${contentHTML}</div>`;
    }
    chatStream.appendChild(bubbleWrapper);
    chatStream.scrollTop = chatStream.scrollHeight;
    return bubbleId;
  }

  function removeLoader(id) {
    const loaderEl = document.getElementById(id);
    if (loaderEl) loaderEl.remove();
  }

  chatSendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
});
