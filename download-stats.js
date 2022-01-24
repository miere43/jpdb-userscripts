// ==UserScript==
// @name         JPDB download stats
// @namespace    http://miere.ru/
// @version      1.0
// @description  Download JPDB stats into JSON file.
// @author       miere
// @match        https://www.jpdb.io/stats
// @icon         https://www.google.com/s2/favicons?domain=jpdb.io
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      self
// ==/UserScript==

(function() {
    'use strict';

    function verifyEquals(expected, actual, message) {
        if (expected !== actual) {
            throw new Error(`Expected value "${expected}", got "${actual}": ${message ?? 'unknown'}`);
        }
    }

    function toISOString(date) {
        var tzo = -date.getTimezoneOffset(),
            dif = tzo >= 0 ? '+' : '-',
            pad = function(num) {
                var norm = Math.floor(Math.abs(num));
                return (norm < 10 ? '0' : '') + norm;
            };

        return date.getFullYear() +
            '-' + pad(date.getMonth() + 1) +
            '-' + pad(date.getDate()) +
            'T' + pad(date.getHours()) +
            ':' + pad(date.getMinutes()) +
            ':' + pad(date.getSeconds()) +
            dif + pad(tzo / 60) +
            ':' + pad(tzo % 60);
    }

    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;
    function dayNameToDate(name) {
        const names = ['Today', 'Yesterday', '2 days ago', '3 days ago', '4 days ago', '5 days ago', '6 days ago', '7 days ago'];
        for (let i = 0; i < names.length; ++i) {
            if (name === names[i]) {
                return new Date(now.getTime() - oneDay * i);
            }
        }
        throw new Error(`invalid day name "${name}"`);
    }

    function normalizeDatasetLabel(label) {
        switch (label) {
            case 'New cards': return 'newCards';
            case 'Old cards (failed)': return 'oldCardsFailed';
            case 'Old cards (passed)': return 'oldCardsPassed';
        }
        throw new Error(`invalid dataset label "${name}"`);
    }

    function normalizeRetentionRateKey(key) {
        switch (key) {
            case 'Learning': return 'learning';
            case 'Known': return 'known';
        }
        throw new Error(`invalid retention rate key "${key}"`);
    }

    function parseLearn(html) {
        const result = {
            time: toISOString(now),
            version: 2,
        };
        var cells = html.querySelector('table').querySelectorAll('td');
        for (let i = 0; i < cells.length; i += 4) {
            const key = cells[i + 0].textContent;
            const total = parseInt(cells[i + 1].textContent);
            const learning = parseInt(cells[i + 2].textContent);
            const youKnow = parseInt(cells[i + 3].textContent);

            result[key === 'Words\u00a0(direct)' ? 'directWords' : 'indirectWords'] = {
                total: total,
                learning: learning,
                youKnow: youKnow,
            };
        }

        result.blacklisted = 0;
        result.dueVocabularyCards = 0;
        result.newVocabularyCards = 0;
        const paragraphs = html.querySelectorAll('p');
        for (const paragraph of paragraphs) {
            const text = paragraph.textContent.trim();
            if (text.startsWith('You currently have ')) {
                result.blacklisted = parseInt(text.slice('You currently have '.length));
            } else if (text.startsWith('You have ')) {
                const strongs = paragraph.getElementsByClassName('strong');
                let dueStrong = null;
                let newStrong = null;

                if (strongs.length >= 2) {
                    dueStrong = strongs[0];
                    newStrong = strongs[1];
                } else if (strongs.length > 0 && text.includes('new vocabulary')) {
                    newStrong = strongs[0];
                } else if (strongs.length > 0 && text.includes('overdue vocabulary')) {
                    dueStrong = strongs[0];
                }

                if (dueStrong) {
                    result.dueVocabularyCards = parseInt(dueStrong.textContent.trim());
                }
                if (newStrong) {
                    result.newVocabularyCards = parseInt(newStrong.textContent.trim());
                }
            }
        }

        const deckList = html.querySelector('.deck-list');
        result.decks = deckList ? deckList.childElementCount : 0;
        const buttons = html.querySelectorAll('a[class="button-link"]');
        for (const button of buttons) {
            if (button.textContent.endsWith(' more decks...')) {
                result.decks += parseInt(button.textContent);
                break;
            }
        }

        return result;
    }

    function parseStats(html) {
        const cardsPerDayChart = Chart.getChart('chart');

        const cardsPerDay = [];
        for (let i = 0; i < cardsPerDayChart.data.labels.length; ++i) {
            const dayName = cardsPerDayChart.data.labels[i];
            const time = dayNameToDate(dayName);
            const data = {
                time: toISOString(time),
            };
            const values = {};
            for (const dataset of cardsPerDayChart.data.datasets) {
                data[normalizeDatasetLabel(dataset.label)] = dataset.data[i];
            }
            cardsPerDay.push(data);
        }

        const cardsByLevelChart = Chart.getChart('chart2');
        if (cardsByLevelChart.data.datasets.length !== 1) {
            throw new Error(`unexpected datasets length for Cards by Level chart`);
        }

        const cardsByLevel = [];
        for (let i = 0; i < cardsByLevelChart.data.labels.length; ++i) {
            const level = cardsByLevelChart.data.labels[i];
            cardsByLevel.push({
                level: parseInt(level),
                cards: cardsByLevelChart.data.datasets[0].data[i],
            });
        }

        const retentionRate = {};
        const retentionRateTableItems = html.querySelector('.cross-table').querySelectorAll('th, td');
        for (let i = 0; i < retentionRateTableItems.length; i += 2) {
            const key = retentionRateTableItems[i + 0];
            const value = retentionRateTableItems[i + 1];
            retentionRate[normalizeRetentionRateKey(key.textContent.trim())] = value.textContent.trim().toLowerCase();
        }

        let currentStreak = null;
        let leaderboard = null;
        for (const paragraph of html.querySelectorAll('p')) {
            const text = paragraph.textContent.trim();
            if (text.startsWith('Current streak: ')) {
                currentStreak = parseInt(text.slice('Current streak: '.length));
            } else if (text.startsWith("You're currently ")) {
                leaderboard = parseInt(text.slice("You're currently ".length));
            }
        }

        // This is now parsed in "parseLearn" alongside new vocabulary count.
        /*
        let overdueCards = 0;
        const learnButtonText = html.querySelector('a[href="/learn"]').textContent;
        if (learnButtonText.startsWith('Learn (')) {
            overdueCards = parseInt(learnButtonText.slice('Learn ('.length, learnButtonText.indexOf(')')));
        }
        */

        return {
            time: toISOString(now),
            currentStreak: currentStreak,
            leaderboard: leaderboard,
            cardsPerDay: cardsPerDay,
            cardsByLevel: cardsByLevel,
            retentionRate: retentionRate,
            //overdueCards: overdueCards,
        };
    }

    function parseRanking(ranking) {
        const items = [];
        for (const entry of ranking.getElementsByClassName('ranking-entry')) {
            const firstRow = entry.children[0].children[0];
            let rank = null;
            let index = 0;
            if (firstRow.childElementCount === 2) {
                rank = parseInt(firstRow.children[index].textContent.trim());
                ++index;
            }
            const nickname = firstRow.children[index].textContent.trim();

            const secondRow = entry.children[1];
            const thisIsYou = secondRow.children[0].textContent.trim() === 'This is you!';
            const cards = parseInt(secondRow.children[1].textContent.trim());

            items.push({
                rank: rank,
                nickname: nickname,
                isCurrentUser: thisIsYou,
                cards: cards,
            });
        }
        return items;
    }

    function parseLeaderboard(html) {
        const rankings = html.getElementsByClassName('ranking');
        verifyEquals(rankings.length, 2, 'rankings');
        return {
            newCardsRanking: parseRanking(rankings[0]),
            oldCardsRetainedRanking: parseRanking(rankings[1]),
        }
    }

    function parsePage(html, handler, resolve) {
        const result = handler(html);
        if (resolve) resolve(result);
    }

    function loadAndParsePage(url, handler, resolve) {
        GM_xmlhttpRequest({
            url: url,
            method: 'GET',
            onload(args) {
                if (args.readyState !== XMLHttpRequest.DONE) {
                    return;
                }
                const domParser = new DOMParser();
                const html = domParser.parseFromString(args.responseText, 'text/html');
                parsePage(html, handler, resolve);
            }
        });
    }

    const button = document.createElement('a');
    button.href = '#'; // Show pointer cursor
    button.classList.add('outline');

    function setButtonInfo(count, maxCount) {
        if (count === undefined) {
            button.textContent = 'Save info';
            button.removeAttribute('disabled');
        } else {
            button.textContent = `Saving info (${count}/${maxCount})...`;
            button.setAttribute('disabled', '');
        }
    }
    setButtonInfo();

    button.onclick = event => {
        event.preventDefault();

        if (GM_info.downloadMode !== 'browser') {
            alert('Set "downloadMode" to "browser" in Tampermonkey settings.');
        }

        let expectedResults = 0;
        const callbacks = [];
        const prepare = callback => {
            ++expectedResults;
            callbacks.push(callback);
        };

        const results = [];
        const resolveResult = result => {
            results.push(result);
            setButtonInfo(results.length, expectedResults);

            if (results.length === expectedResults) {
                const data = {};
                for (const result of results) {
                    Object.assign(data, result);
                }
                GM_download({
                    url: 'data:text/json;,' + encodeURIComponent(JSON.stringify(data, null, 2)),
                    name: `jpdb/stats-${now.getTime().toString()}.json`,
                });
                console.log('saved', data);
            }

            setButtonInfo();
        };

        prepare(() => loadAndParsePage('/learn', parseLearn, resolveResult));
        prepare(() => loadAndParsePage('/leaderboard', parseLeaderboard, resolveResult));
        prepare(() => parsePage(document, parseStats, resolveResult));

        setButtonInfo(0, expectedResults);
        for (const callback of callbacks) {
            callback();
        }
    };
    const wrapper = document.createElement('div');
    wrapper.style = 'text-align: center; padding: 1em 0';
    wrapper.appendChild(button);
    document.querySelector('.container.bugfix').prepend(wrapper);
})();