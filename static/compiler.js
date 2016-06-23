// Copyright (c) 2012-2016, Matt Godbolt
//
// All rights reserved.
// 
// Redistribution and use in source and binary forms, with or without 
// modification, are permitted provided that the following conditions are met:
// 
//     * Redistributions of source code must retain the above copyright notice, 
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright 
//       notice, this list of conditions and the following disclaimer in the 
//       documentation and/or other materials provided with the distribution.
// 
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE 
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE 
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR 
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF 
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS 
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN 
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) 
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE 
// POSSIBILITY OF SUCH DAMAGE.

function parseLines(lines, callback) {
    var re = /^\/tmp\/[^:]+:([0-9]+)(:([0-9]+))?:\s+(.*)/;
    $.each(lines.split('\n'), function (_, line) {
        line = line.trim();
        if (line !== "") {
            var match = line.match(re);
            if (match) {
                callback(parseInt(match[1]), match[4].trim());
            } else {
                callback(null, line);
            }
        }
    });
}

function clearBackground(cm) {
    for (var i = 0; i < cm.lineCount(); ++i) {
        cm.removeLineClass(i, "background", null);
    }
}

const NumRainbowColours = 12;

// This function is called in function initialise in static/gcc.js
function Compiler(domRoot, origFilters, windowLocalPrefix, onEditorChangeCallback, lang) {
    console.log("Entering in function Compiler()");
    var slotsCount = 2;
    var slotsClassName = ["asm0", "asm1"];
    var compilersById = {};
    var compilersByAlias = {};

    // The time out is not slot dependant : 
    // it correponds to the time in ms after which resend code to compiler 
    var pendingTimeout = null;

    var asmCodeMirrors = [];
    for (var i = 0; i<slotsCount; i++) {
        asmCodeMirrors.push(null);
    }

    var cppEditor = null;

    // may be seen as slot dependant... or not !
    var lastRequest = [];
    for (var i = 0; i<slotsCount; i++) {
        lastRequest.push(null);
    }

    var currentAssembly = [];
    for (var i = 0; i<slotsCount; i++) {
        currentAssembly.push(null);
    }

    var filters_ = $.extend({}, origFilters);
    var ignoreChanges = true; // Horrible hack to avoid onEditorChange doing anything on first starting, ie before we've set anything up.

    // to be modified
    function setCompilerById(id) {
        var compilerNode = domRoot.find('.compiler');
        compilerNode.text(compilersById[id].name);
        compilerNode.attr('data', id);
    }

    // to be modified
    function currentCompilerId() {
        return domRoot.find('.compiler').attr('data');
    }

    // to be modified
    function currentCompiler() {
        return compilersById[currentCompilerId()];
    }

    $('.autocompile').click(function () {
        $('.autocompile').toggleClass('active');
        onEditorChange();
        setSetting('autocompile', $('.autocompile').hasClass('active'));
    });
    $('.autocompile').toggleClass('active', getSetting("autocompile") !== "false");

    function patchUpFilters(filters) {
        filters = $.extend({}, filters);
        var compiler = currentCompiler();
        var compilerSupportsBinary = compiler ? compiler.supportsBinary : true;
        if (filters.binary && !(OPTIONS.supportsBinary && compilerSupportsBinary)) {
            filters.binary = false;
        }
        return filters;
    }

    var cmMode;
    switch (lang.toLowerCase()) {
        default:
            cmMode = "text/x-c++src";
            break;
        case "c":
            cmMode = "text/x-c";
            break;
        case "rust":
            cmMode = "text/x-rustsrc";
            break;
        case "d":
            cmMode = "text/x-d";
            break;
        case "go":
            cmMode = "text/x-go";
            break;
    }

    cppEditor = CodeMirror.fromTextArea(domRoot.find(".editor textarea")[0], {
        lineNumbers: true,
        matchBrackets: true,
        useCPP: true,
        mode: cmMode
    });
    // With reference to "fix typing '#' in emacs mode"
    // https://github.com/mattgodbolt/gcc-explorer/pull/131
    cppEditor.setOption("extraKeys", {
      "Alt-F": false
    });
    cppEditor.on("change", function () {
        if ($('.autocompile').hasClass('active')) {
            onEditorChange();
        }
    });

    for (var i = 0; i < slotsCount; i++) {
        asmCodeMirrors[i] = CodeMirror.fromTextArea(domRoot.find("." + slotsClassName[i] + " textarea")[0], {
            lineNumbers: true,
            mode: "text/x-asm",
            readOnly: true,
            gutters: ['CodeMirror-linenumbers']
        });
        //console.log(JSON.stringify(asmCodeMirrors[i]));
    }

    function getSetting(name) {
        return window.localStorage[windowLocalPrefix + "." + name];
    }

    function setSetting(name, value) {
        window.localStorage[windowLocalPrefix + "." + name] = value;
    }

    var codeText = getSetting('code');
    if (!codeText) codeText = $(".template.lang." + lang.replace(/[^a-zA-Z]/g, '').toLowerCase()).text();
    if (codeText) cppEditor.setValue(codeText);

    // to be modified
    domRoot.find('.compiler_options').change(onParamChange).keyup(onParamChange);
    ignoreChanges = false;


    // to be modified
    if (getSetting('compilerOptions')) {
        domRoot.find('.compiler_options').val(getSetting('compilerOptions'));
    }

    function makeErrNode(text) {
        var clazz = "error";
        if (text.match(/^warning/)) clazz = "warning";
        if (text.match(/^note/)) clazz = "note";
        var node = $('<div class="' + clazz + ' inline-msg"><span class="icon">!!</span><span class="msg"></span></div>');
        node.find(".msg").text(text);
        return node[0];
    }

    var errorWidgets = [];

    function echo_to_out(out,msg) {
        out += msg;
    }

    function onCompileResponse(request, data) {
        //console.log("In onCompileResponse, seen slot = " + request.slot);
        var stdout = data.stdout || "";
        var stderr = data.stderr || "";
        if (data.code === 0) {
            //echo_to_out(stdout,"\nCompiled ok in slot " + slot); // does not seem to work
            //stdout += "\nCompiled ok in slot " + slot;
            stdout += "Compiled ok in slot " + request.slot + "\n";
        } else {
            //echo_to_out(stderr,"\nCompilation failed in slot " + slot); // does not seem to work
            //stderr += "\nCompilation failed in slot " + slot;
            stderr += "Compilation failed in slot " + request.slot + "\n";
        }
        if (_gaq) {
            // to be modified
            _gaq.push(['_trackEvent', 'Compile', request.compiler, request.options, data.code]);
            _gaq.push(['_trackTiming', 'Compile', 'Timing', new Date() - request.timestamp]);
        }
        $('.result .output :visible').remove();
        for (var i = 0; i < errorWidgets.length; ++i)
            cppEditor.removeLineWidget(errorWidgets[i]);
        errorWidgets.length = 0;
        var numLines = 0;
        parseLines(stderr + stdout, function (lineNum, msg) {
            if (numLines > 50) return;
            if (numLines === 50) {
                lineNum = null;
                msg = "Too many output lines...truncated";
            }
            numLines++;
            var elem = $('.result .output'+request.slot+' .template').clone().appendTo('.result .output'+request.slot).removeClass('template');
            if (lineNum) {
                errorWidgets.push(cppEditor.addLineWidget(lineNum - 1, makeErrNode(msg), {
                    coverGutter: false, noHScroll: true
                }));
                elem.html($('<a href="#">').text(lineNum + " : " + msg)).click(function () {
                    cppEditor.setSelection({line: lineNum - 1, ch: 0}, {line: lineNum, ch: 0});
                    return false;
                });
            } else {
                elem.text(msg);
            }
        });
        //for (var i = 0; i < slotsCount; i++) {
            currentAssembly[request.slot] = data.asm || fakeAsm("[no output]");
            updateAsm(request.slot);
        //}
    }

    function numberUsedLines(asm) {
        var sourceLines = {};
        $.each(asm, function (_, x) {
            if (x.source) sourceLines[x.source - 1] = true;
        });
        var ordinal = 0;
        $.each(sourceLines, function (k, _) {
            sourceLines[k] = ordinal++;
        });
        var asmLines = {};
        $.each(asm, function (index, x) {
            if (x.source) asmLines[index] = sourceLines[x.source - 1];
        });
        return {source: sourceLines, asm: asmLines};
    }

    var lastUpdatedAsm = [];
    for (var i = 0; i < slotsCount; i++) {
        lastUpdatedAsm.push(null);
    }

    function updateAsm(slot,forceUpdate) {
        //console.log("In updateAsm, slot = " + slot + ",asmCodeMirrors = " + asmCodeMirrors[slot] + "forceUpdate = " + forceUpdate);
        if (!currentAssembly[slot]) return;
        var hashedUpdate = JSON.stringify(currentAssembly[slot]);
        // TODO : real hash here ?
        if (!forceUpdate && lastUpdatedAsm[slot] == hashedUpdate) {
            return;
        }
        lastUpdatedAsm[slot] = hashedUpdate;

        var asmText = $.map(currentAssembly[slot], function (x) {
            return x.text;
        }).join("\n");
        var numberedLines = numberUsedLines(currentAssembly[slot]);

        cppEditor.operation(function () {
            clearBackground(cppEditor);
        });
        var filters = currentFilters();
        asmCodeMirrors[slot].operation(function () {
            asmCodeMirrors[slot].setValue(asmText);
            clearBackground(asmCodeMirrors[slot]);
            var addrToAddrDiv = {};
            $.each(currentAssembly[slot], function (line, obj) {
                var address = obj.address ? obj.address.toString(16) : "";
                var div = $("<div class='address cm-number'>" + address + "</div>");
                addrToAddrDiv[address] = {div: div, line: line};
                asmCodeMirrors[slot].setGutterMarker(line, 'address', div[0]);
            });
            $.each(currentAssembly[slot], function (line, obj) {
                var opcodes = $("<div class='opcodes'></div>");
                if (obj.opcodes) {
                    var title = [];
                    $.each(obj.opcodes, function (_, op) {
                        var opcodeNum = "00" + op.toString(16);
                        opcodeNum = opcodeNum.substr(opcodeNum.length - 2);
                        title.push(opcodeNum);
                        var opcode = $("<span class='opcode'>" + opcodeNum + "</span>");
                        opcodes.append(opcode);
                    });
                    opcodes.attr('title', title.join(" "));
                }
                asmCodeMirrors[slot].setGutterMarker(line, 'opcodes', opcodes[0]);
                if (obj.links) {
                    $.each(obj.links, function (_, link) {
                        var from = {line: line, ch: link.offset};
                        var to = {line: line, ch: link.offset + link.length};
                        var address = link.to.toString(16);
                        var thing = $("<a href='#' class='cm-number'>" + address + "</a>");
                        asmCodeMirrors[slot].markText(
                            from, to, {replacedWith: thing[0], handleMouseEvents: false});
                        var dest = addrToAddrDiv[address];
                        if (dest) {
                            thing.on('hover', function (e) {
                                var entered = e.type == "mouseenter";
                                dest.div.toggleClass("highlighted", entered);
                                thing.toggleClass("highlighted", entered);
                            });
                            thing.on('click', function (e) {
                                asmCodeMirrors[slot].scrollIntoView({line: dest.line, ch: 0}, 30);
                                dest.div.toggleClass("highlighted", false);
                                thing.toggleClass("highlighted", false);
                            });
                        }
                    });
                }
            });
            if (filters.binary) {
                asmCodeMirrors[slot].setOption('lineNumbers', false);
                asmCodeMirrors[slot].setOption('gutters', ['address', 'opcodes']);
            } else {
                asmCodeMirrors[slot].setOption('lineNumbers', true);
                asmCodeMirrors[slot].setOption('gutters', ['CodeMirror-linenumbers']);
            }
        });

        if (filters.colouriseAsm) {
            cppEditor.operation(function () {
                $.each(numberedLines.source, function (line, ordinal) {
                    cppEditor.addLineClass(parseInt(line),
                        "background", "rainbow-" + (ordinal % NumRainbowColours));
                });
            });
            for (var i = 0; i < slotsCount; i++) {
                asmCodeMirrors[slot].operation(function () {
                    $.each(numberedLines.asm, function (line, ordinal) {
                        asmCodeMirrors[slot].addLineClass(parseInt(line),
                            "background", "rainbow-" + (ordinal % NumRainbowColours));
                    });
                });
            }
        }
    }

    function fakeAsm(text) {
        return [{text: text, source: null}];
    }

    function onParamChange() { // TODO : refactor with onEditorChange : those functions will call updateSlot(slot)
        console.log("[CHANGE] in params");
        if (ignoreChanges) return;  // Ugly hack during startup.
        if (pendingTimeout) {
            console.log("Clearing time out");
            clearTimeout(pendingTimeout);
        }

        console.log("Setting time out");
        pendingTimeout = setTimeout(function () {
            console.log("Timed out !");
            for (var i = 0; i < slotsCount; i++) {
                console.log("Compilation in slot " + i + " triggered by modification in compiler parameters...");
                (function(slot) {
                    var data = {
                        slot: slot, // TO DECIDE : probably better not put it here
                        source: cppEditor.getValue(),
                        compiler: currentCompilerId(),
                        options: $('.compiler_options').val(),
                        filters: currentFilters()
                    };
                    setSetting('compiler', data.compiler);
                    setSetting('compilerOptions', data.options);
                    var stringifiedReq = JSON.stringify(data);
                    if (stringifiedReq == lastRequest[slot]) return;
                    lastRequest[slot] = stringifiedReq;
                    data.timestamp = new Date();
                    $.ajax({
                        type: 'POST',
                        url: '/compile',
                        dataType: 'json',
                        contentType: 'application/json',
                        data: JSON.stringify(data),
                        success: function (result) {
                            onCompileResponse(data, result);
                        },
                        error: function (xhr, e_status, error) {
                            console.log("AJAX request failed, reason : " + error);
                        },
                        cache: false
                    });
                    currentAssembly[slot] = fakeAsm("[Processing...]");
                    updateAsm(slot);
                    setSetting('code', cppEditor.getValue());
                    updateAsm(slot);
                }) (i);
            }
        }, 750); // Time in ms after which action is taken (if inactivity)

        // (maybe redundant) execute the callback passed to Compiler()
        onEditorChangeCallback();
    }

    function onEditorChange() {
        console.log("[CHANGE] in editor");
        if (ignoreChanges) return;  // Ugly hack during startup.
        if (pendingTimeout) {
            console.log("Clearing time out");
            clearTimeout(pendingTimeout);
        }

        console.log("Setting time out");
        pendingTimeout = setTimeout(function () {
            console.log("Timed out ! Compiling for " + slotsCount + " slots...");
            for (var i = 0; i < slotsCount; i++) {
                console.log("Compiling for slot " + i + "...");
                (function(slot) {
                    var data = {
                        slot: slot, // TO DECIDE : probably better not put it here
                        source: cppEditor.getValue(),
                        compiler: currentCompilerId(),
                        options: $('.compiler_options').val(),
                        filters: currentFilters()
                    };
                    setSetting('compiler', data.compiler);
                    setSetting('compilerOptions', data.options);
                    var stringifiedReq = JSON.stringify(data);
                    if (stringifiedReq == lastRequest) return;
                    lastRequest[slot] = stringifiedReq;
                    data.timestamp = new Date();
                    $.ajax({
                        type: 'POST',
                        url: '/compile',
                        dataType: 'json',
                        contentType: 'application/json',
                        data: JSON.stringify(data),
                        success: function (result) {
                            onCompileResponse(data, result);
                        },
                        error: function (xhr, e_status, error) {
                            console.log("ajax request failed, reason : " + error);
                        },
                        cache: false
                    });
                    currentassembly[slot] = fakeasm("[processing...]");
                    updateasm(slot);
                }) (i);
            }
        }, 750); // Time in ms after which action is taken (if inactivity)
        setSetting('code', cppEditor.getValue());
        for (var i = 0; i < slotsCount; i++) {
            (function(slot) {
                updateAsm(slot);
            }) (i);
        }
        // execute the callback passed to Compiler()
        onEditorChangeCallback();
    }

    function setSource(code) {
        cppEditor.setValue(code);
    }

    function getSource() {
        return cppEditor.getValue();
    }

    function serialiseState(compress) {
        var state = {
            compiler: currentCompilerId(),
            options: domRoot.find('.compiler_options').val()
        };
        if (compress) {
            state.sourcez = LZString.compressToBase64(cppEditor.getValue());
        } else {
            state.source = cppEditor.getValue();
        }
        return state;
    }

    function deserialiseState(state) {
        if (state.hasOwnProperty('sourcez')) {
            cppEditor.setValue(LZString.decompressFromBase64(state.sourcez));
        } else {
            cppEditor.setValue(state.source);
        }
        state.compiler = mapCompiler(state.compiler);
        setCompilerById(state.compiler);
        domRoot.find('.compiler_options').val(state.options);
        // Somewhat hackily persist compiler into local storage else when the ajax response comes in
        // with the list of compilers it can splat over the deserialized version.
        // The whole serialize/hash/localStorage code is a mess! TODO(mg): fix
        setSetting('compiler', state.compiler);
        for (var i = 0; i < slotsCount; i++) {
            updateAsm(i,true);  // Force the update to reset colours after calling cppEditor.setValue
        }
        return true;
    }

    function updateCompilerAndButtons() {
        var compiler = currentCompiler();
        $(".compilerVersion").text(compiler.name + " (" + compiler.version + ")");
        var filters = currentFilters();
        var supportsIntel = compiler.intelAsm || filters.binary;
        domRoot.find('.filter button.btn[value="intel"]').toggleClass("disabled", !supportsIntel);
        domRoot.find('.filter button.btn[value="binary"]').toggleClass("disabled", !compiler.supportsBinary).toggle(OPTIONS.supportsBinary);
        domRoot.find('.filter .nonbinary').toggleClass("disabled", !!filters.binary);
    }

    function onCompilerChange() {
        //onEditorChange();
        onParamChange();
        updateCompilerAndButtons();
    }

    function mapCompiler(compiler) {
        if (!compilersById[compiler]) {
            // Handle old settings and try the alias table.
            compiler = compilersByAlias[compiler];
            if (compiler) compiler = compiler.id;
        }
        return compiler;
    }

    function setCompilers(compilers, defaultCompiler) {
        domRoot.find('.compilers li').remove();
        compilersById = {};
        compilersByAlias = {};
        $.each(compilers, function (index, arg) {
            compilersById[arg.id] = arg;
            if (arg.alias) compilersByAlias[arg.alias] = arg;
            var elem = $('<li><a href="#">' + arg.name + '</a></li>');
            domRoot.find('.compilers').append(elem);
            (function () {
                elem.click(function () {
                    setCompilerById(arg.id);
                    onCompilerChange();
                });
            })(elem.find("a"), arg.id);
        });
        var compiler = getSetting('compiler');
        if (!compiler) compiler = defaultCompiler;
        compiler = mapCompiler(compiler);
        if (compiler) {
            setCompilerById(compiler);
        }
        onCompilerChange();
    }

    function currentFilters() {
        return patchUpFilters(filters_);
    }

    function setFilters(f) {
        filters_ = $.extend({}, f);
        //onEditorChange();
        onParamChange();
        updateCompilerAndButtons();
    }

    function setEditorHeight(height) {
        const MinHeight = 100;
        if (height < MinHeight) height = MinHeight;
        cppEditor.setSize(null, height);

        for (var i = 0; i < slotsCount; i++) {
            asmCodeMirrors[i].setSize(null, height);
        }
    }

    return {
        serialiseState: serialiseState,
        deserialiseState: deserialiseState,
        setCompilers: setCompilers,
        getSource: getSource,
        setSource: setSource,
        setFilters: setFilters,
        setEditorHeight: setEditorHeight
    };
}
