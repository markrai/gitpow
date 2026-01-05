/**
 * Searchable Dropdown Component for GitPow
 * A custom dropdown that looks like native select but has search functionality
 * Extracted from script.js for better maintainability
 */

/**
 * Create a searchable dropdown from a select element
 * @param {HTMLSelectElement} selectElement - The select element to enhance
 * @param {Object} options - Configuration options
 * @param {string} options.placeholder - Search input placeholder text
 * @param {string} options.maxHeight - Maximum dropdown height (CSS value)
 * @returns {Object} Public API with setValue, getValue, updateOptions methods
 */
function createSearchableDropdown(selectElement, options = {}) {
  const {
    placeholder = "Search...",
    maxHeight = "200px"
  } = options;

  // Create container that looks like the original select
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.display = "inline-block";
  container.style.zIndex = "10002"; // Ensure container is above all content
  const computedStyle = window.getComputedStyle(selectElement);
  // Preserve width from original select, but ensure it's not too constrained
  const originalWidth = computedStyle.width;
  container.style.width = originalWidth;
  container.style.minWidth = originalWidth; // Prevent shrinking
  container.className = "searchable-dropdown-container";

  // Create button that looks like the select element
  const button = document.createElement("button");
  button.type = "button";
  button.style.cssText = computedStyle.cssText || selectElement.style.cssText || "";
  button.style.width = "100%";
  button.style.textAlign = "left";
  button.style.cursor = "pointer";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "space-between";
  button.style.background = computedStyle.background || "rgba(15, 23, 42, 0.9)";
  button.style.border = computedStyle.border || "1px solid #374151";
  button.style.borderRadius = computedStyle.borderRadius || "999px";
  button.style.padding = computedStyle.padding || "6px 10px";
  button.style.color = computedStyle.color || "#e5e7eb";
  button.style.fontSize = computedStyle.fontSize || "13px";
  button.style.overflow = "hidden";
  button.style.textOverflow = "ellipsis";
  button.style.whiteSpace = "nowrap";
  button.setAttribute("aria-label", selectElement.getAttribute("aria-label") || "");

  // Create text span for the button content
  const buttonText = document.createElement("span");
  buttonText.style.cssText = "flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; margin-right: 4px;";
  button.appendChild(buttonText);

  // Add arrow icon
  const arrow = document.createElement("span");
  arrow.innerHTML = "▼";
  arrow.style.cssText = "font-size: 10px; color: #9ca3af; margin-left: 8px; pointer-events: none; flex-shrink: 0;";
  button.appendChild(arrow);

  // Create dropdown list with search box
  const dropdown = document.createElement("div");
  dropdown.style.cssText = `
    position: fixed;
    background: rgba(15, 23, 42, 0.98);
    border: 1px solid #374151;
    border-radius: 6px;
    max-height: ${maxHeight};
    overflow: hidden;
    z-index: 10003;
    display: none;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    flex-direction: column;
    width: max-content;
    max-width: 400px;
  `;
  dropdown.className = "searchable-dropdown-list";

  // Create search input at the top
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = placeholder;
  searchInput.style.cssText = `
    width: 100%;
    padding: 6px 10px;
    background: rgba(15, 23, 42, 0.9);
    border: none;
    border-bottom: 1px solid #374151;
    border-radius: 6px 6px 0 0;
    color: #e5e7eb;
    font-size: 13px;
    outline: none;
    box-sizing: border-box;
  `;
  dropdown.appendChild(searchInput);

  // Create options container
  const optionsContainer = document.createElement("div");
  optionsContainer.style.cssText = `
    overflow-y: auto;
    max-height: calc(${maxHeight} - 40px);
  `;
  dropdown.appendChild(optionsContainer);

  // Store original options
  let allOptions = [];
  let selectedValue = selectElement.value;
  let selectedText = "";

  // Initialize options from select element
  function initializeOptions() {
    allOptions = [];
    Array.from(selectElement.options).forEach(opt => {
      allOptions.push({
        value: opt.value,
        text: opt.textContent,
        element: opt
      });
      if (opt.selected) {
        selectedValue = opt.value;
        selectedText = opt.textContent;
        updateButtonText();
      }
    });
  }

  // Update button text
  function updateButtonText() {
    buttonText.textContent = selectedText || "Select...";
  }

  // Render filtered options
  function renderOptions(filter = "") {
    optionsContainer.innerHTML = "";
    const filterLower = filter.toLowerCase();
    const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";

    // First filter by search text
    let filtered = allOptions.filter(opt =>
      opt.text.toLowerCase().includes(filterLower) ||
      opt.value.toLowerCase().includes(filterLower)
    );

    // Then filter by active status if Active Only is enabled
    if (activeOnly && window.state && window.state.branchMetadata) {
      filtered = filtered.filter(opt => {
        // Always show __ALL__ option
        if (opt.value === "__ALL__") return true;
        const metadata = window.state.branchMetadata[opt.value];
        return window.isBranchActive && window.isBranchActive(opt.value, metadata);
      });
    }

    if (filtered.length === 0) {
      const noResults = document.createElement("div");
      noResults.style.cssText = "padding: 8px 12px; color: #9ca3af; font-size: 12px; text-align: center;";
      noResults.textContent = "No results found";
      optionsContainer.appendChild(noResults);
    } else {
      filtered.forEach(opt => {
        const item = document.createElement("div");
        let baseStyle = `
          padding: 8px 12px;
          cursor: pointer;
          font-size: 13px;
          color: #e5e7eb;
          transition: background 0.15s ease;
        `;

        item.style.cssText = baseStyle;
        item.textContent = opt.text;
        item.dataset.value = opt.value;

        if (opt.value === selectedValue) {
          item.style.background = "rgba(34, 197, 94, 0.2)";
          item.style.color = "#22c55e";
        }

        item.addEventListener("mouseenter", () => {
          if (opt.value !== selectedValue) {
            item.style.background = "rgba(59, 130, 246, 0.2)";
          }
        });
        item.addEventListener("mouseleave", () => {
          if (opt.value !== selectedValue) {
            item.style.background = "transparent";
          }
        });
        item.addEventListener("click", () => {
          selectOption(opt.value, opt.text);
        });
        optionsContainer.appendChild(item);
      });
    }
  }

  // Select an option
  function selectOption(value, text) {
    selectedValue = value;
    selectedText = text;
    updateButtonText();
    dropdown.style.display = "none";
    searchInput.value = "";

    // Update the original select element
    selectElement.value = value;

    // Trigger change event on select element
    const event = new Event("change", { bubbles: true });
    selectElement.dispatchEvent(event);
  }

  // Show dropdown
  function showDropdown() {
    searchInput.value = "";
    renderOptions("");
    
    // Calculate position using fixed positioning to ensure it's above all content
    // Fixed positioning is relative to viewport, so use getBoundingClientRect directly
    const rect = button.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.minWidth = `${rect.width}px`;
    
    dropdown.style.display = "flex";
    setTimeout(() => searchInput.focus(), 10);
  }

  // Hide dropdown
  function hideDropdown(force = false) {
    if (force) {
      dropdown.style.display = "none";
      searchInput.value = "";
      return;
    }
    setTimeout(() => {
      if (!container.contains(document.activeElement)) {
        dropdown.style.display = "none";
        searchInput.value = "";
      }
    }, 200);
  }

  // Toggle dropdown
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.style.display === "none" || dropdown.style.display === "") {
      showDropdown();
    } else {
      hideDropdown(true);
    }
  });

  // Search input event
  searchInput.addEventListener("input", (e) => {
    renderOptions(e.target.value);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideDropdown(true);
    } else if (e.key === "Enter") {
      const firstItem = optionsContainer.querySelector("[data-value]");
      if (firstItem) {
        firstItem.click();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(optionsContainer.querySelectorAll("[data-value]"));
      const currentIndex = items.findIndex(item => item.style.background.includes("rgba(59, 130, 246"));
      let nextIndex = currentIndex;

      if (e.key === "ArrowDown") {
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      }

      items.forEach((item, idx) => {
        if (idx === nextIndex) {
          item.style.background = "rgba(59, 130, 246, 0.3)";
          item.scrollIntoView({ block: "nearest" });
        } else if (item.dataset.value !== selectedValue) {
          item.style.background = "transparent";
        }
      });
    }
  });

  // Track if mouse is over dropdown to prevent closing on scroll
  let isMouseOverDropdown = false;
  dropdown.addEventListener("mouseenter", () => {
    isMouseOverDropdown = true;
  });
  dropdown.addEventListener("mouseleave", () => {
    isMouseOverDropdown = false;
  });
  
  // Close dropdown when clicking outside
  // Use capture phase to ensure we catch all clicks before they bubble
  const handleClickOutside = (e) => {
    if (!container.contains(e.target) && !dropdown.contains(e.target)) {
      hideDropdown(true);
    }
  };
  document.addEventListener("click", handleClickOutside, true);
  
  // Also close on window scroll/resize to prevent misalignment
  // But only if the scroll is not happening inside the dropdown
  const handleWindowScroll = (e) => {
    if (dropdown.style.display !== "none" && dropdown.style.display !== "") {
      // Don't close if mouse is over dropdown or if scrolling inside the dropdown
      if (isMouseOverDropdown || (e && e.target && dropdown.contains(e.target))) {
        return;
      }
      hideDropdown(true);
    }
  };
  const handleWindowResize = () => {
    if (dropdown.style.display !== "none" && dropdown.style.display !== "") {
      hideDropdown(true);
    }
  };
  window.addEventListener("scroll", handleWindowScroll, true);
  window.addEventListener("resize", handleWindowResize);
  
  // Prevent wheel events on the dropdown from closing it
  // Allow scrolling within the options container
  optionsContainer.addEventListener("wheel", (e) => {
    e.stopPropagation();
    // Allow normal scrolling behavior
  }, { passive: true });
  
  // Also prevent wheel events on the dropdown itself from bubbling
  dropdown.addEventListener("wheel", (e) => {
    e.stopPropagation();
  }, { passive: true });
  
  // Store cleanup function for potential future use
  container._cleanupClickOutside = () => {
    document.removeEventListener("click", handleClickOutside, true);
    window.removeEventListener("scroll", handleWindowScroll, true);
    window.removeEventListener("resize", handleWindowResize);
    // Remove dropdown from DOM when cleaning up
    if (dropdown.parentNode) {
      dropdown.parentNode.removeChild(dropdown);
    }
  };

  // Replace select with container
  selectElement.parentNode.insertBefore(container, selectElement);
  container.appendChild(button);
  // Append dropdown to body for better stacking context control
  document.body.appendChild(dropdown);
  selectElement.style.display = "none";

  // Initialize
  initializeOptions();
  renderOptions();
  updateButtonText();

  // Public API
  return {
    setValue: (value) => {
      const opt = allOptions.find(o => o.value === value);
      if (opt) {
        selectOption(value, opt.text);
      }
    },
    getValue: () => selectedValue,
    updateOptions: () => {
      initializeOptions();
      renderOptions();
      updateButtonText();
    }
  };
}

// ============================================================================
// Export to window for global access
// ============================================================================

window.createSearchableDropdown = createSearchableDropdown;
