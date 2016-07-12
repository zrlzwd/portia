import Ember from "ember";

const IMPLICIT_TAGS = new Set(['tbody']);
let escapeCSS = CSS.escape;

export function elementPath(element) {
    const elements = [element];
    while (element.parentElement &&
            !element.parentElement.isEqualNode(document.documentElement)) {
        element = element.parentElement;
        elements.unshift(element);
    }
    return elements;
}

function positionInParent(element) {
    return Array.prototype.indexOf.call(element.parentNode.children, element) + 1;
}

export function pathSelector(element) {
    const path = elementPath(element);
    return path.map(pathElement => pathElement.tagName.toLowerCase()).join(' > ');
}

export function uniquePathSelector(element) {
    const path = elementPath(element);
    return path.map((pathElement, index) => {
        const tag = pathElement.tagName.toLowerCase();
        if (index === 0) {
            return tag;
        }
        const parentIndex = positionInParent(pathElement);
        return `${tag}:nth-child(${parentIndex})`;
    }).join(' > ');
}

export function smartSelector(element) {
    const generator = BaseSelectorGenerator.create({
        elements: [element]
    });
    const selector = generator.get('selector');
    generator.destroy();
    return selector;
}

export function cssToXpath(selector) {
    // css-to-xpath on github fails on nth-child(an+b) selectors :(
    // this is mini version that supports only the css generated by BaseSelectorGenerator
    // rules from: https://en.wikibooks.org/wiki/XPath/CSS_Equivalents
    // TODO: support CSS escaped identifiers
    const alternateSelectors = selector.split(', ');
    const alternateXPaths = [];

    for (let alternateSelector of alternateSelectors) {
        const selectorParts = alternateSelector.split(' > ');
        const xPathParts = [];

        for (let selectorPart of selectorParts) {
            const selectorSiblingParts = selectorPart.split(' + ');
            const xPathSiblingParts = [];

            for (let part of selectorSiblingParts) {
                // cases we need to support
                if (part === '*') {
                    xPathSiblingParts.push('*[1]');
                // id selector
                } else if (part.startsWith('#')) {
                    xPathSiblingParts.push(`*[@id="${part.slice(1)}"]`);
                } else {
                    let match;
                    match = part.match(/^([a-z]+[0-9]?)?(?:\.((?:.(?!:nth-child))+.))?(?::nth-child\((\d+)\))?(?::nth-child\((\d*)n\+(\d+)\))?(?::nth-child\(-(\d*)n\+(\d+)\))?$/);  // jshint ignore:line
                    if (match) {
                        let conditions = '';

                        // simple :nth-child selectors
                        if (match[3]) {
                            conditions += `[${match[3]}]`;
                        }

                        // complex :nth-child selectors
                        if (match[5] || match[7]) {
                            const delta = match[4] === undefined ? match[6] : match[4];
                            const start = match[5];
                            const end = match[7];
                            const modulus = (start === undefined ? end : start) % delta;
                            let condition = `position() mod ${delta} = ${modulus}`;
                            if (start && start > delta) {
                                condition += ` and position() >= ${start}`;
                            }
                            if (end) {
                                condition += ` and position() <= ${end}`;
                            }
                            conditions += `[${condition}]`;
                        }

                        // class selector
                        if (match[2]) {
                            conditions += `[contains(concat(" ", @class, " "), " ${match[2]} ")]`;
                        }

                        xPathSiblingParts.push(`${match[1] || '*'}${conditions}`);
                    }
                }
            }
            xPathParts.push(xPathSiblingParts.join('/following-sibling::'));
        }
        alternateXPaths.push('//' + xPathParts.join('/'));
    }

    return alternateXPaths.join(' | ');
}

export const BaseSelectorGenerator = Ember.Object.extend({
    parent: null,
    elements: [],
    siblings: null,

    paths: Ember.computed.map('elements', elementPath),
    groupedPaths: Ember.computed('paths', function() {
        const paths = this.get('paths');
        return this.groupPaths(paths);
    }),
    parentMap: Ember.computed(
        'parent', 'parent.groupedPaths', 'parent.selectors', 'parent.siblings', function() {
            if (!this.get('parent')) {
                return null;
            }

            const parentGroupedPaths = this.get('parent.groupedPaths') || [];
            const parentSelectors = this.get('parent.selectors') || [];
            const parentSiblings = this.get('parent.siblings') || 0;

            const parentMap = new Map();
            for (let [index, paths] of parentGroupedPaths.entries()) {
                const pathSelectors = parentSelectors[index];
                const siblingSelectors = [pathSelectors];
                for (let i = 0; i < parentSiblings; i++) {
                    siblingSelectors.push(
                        siblingSelectors[siblingSelectors.length - 1].map(
                            selector => `${selector} + *`));
                }
                for (let path of paths) {
                    let element = path[path.length - 1];
                    parentMap.set(element, pathSelectors);
                    for (let i = 0; i < parentSiblings; i++) {
                        element = element.nextElementSibling;
                        if (!element) {
                            break;
                        }
                        parentMap.set(element, siblingSelectors[i + 1]);
                    }
                }
            }

            return parentMap;
        }),
    selectors: Ember.computed('groupedPaths', 'parentMap', function() {
        const groupedPaths = this.get('groupedPaths');
        const parentMap = this.get('parentMap');
        return this.createSelectors(groupedPaths, parentMap);
    }),
    selector: Ember.computed('selectors', function() {
        const selectors = this.get('selectors');

        // filter out selectors with trailing implicit tags, if a selector
        // without the tag also exists, otherwise the combined selector may
        // match too many elements
        const filteredSelectors = [];
        for (let selectorGroup of selectors) {
            for (let selector of selectorGroup) {
                const selectorParts = selector.split(' > ');
                const trailingTag = selectorParts[selectorParts.length - 1];
                if (!IMPLICIT_TAGS.has(trailingTag) ||
                        !selectorGroup.includes(selectorParts.slice(0, -1).join(' > '))) {
                    filteredSelectors.push(selector);
                }
            }
        }

        return this.mergeSelectors(filteredSelectors);
    }),
    xpath: Ember.computed('selector', function() {
        const selector = this.get('selector');
        return cssToXpath(selector);
    }),

    groupPaths(paths) {
        const groupedPaths = new Map();
        for (let path of paths) {
            // group by full path of tags names, and root element
            const tagPath = [Ember.guidFor(path[0])].concat(path.map(element => element.tagName))
                                                    .join(' ').toLowerCase();
            const list = groupedPaths.get(tagPath) || [];
            groupedPaths.set(tagPath, list);
            list.push(path);
        }
        return Array.from(groupedPaths.values());
    },

    createSelectors(groupedPaths, parentMap) {
        return groupedPaths.map(group => this.createGroupSelectors(group, parentMap));
    },

    createGroupSelectors(group, parentMap, generalize = false) {
        const root = group && group[0] && group[0][0];
        let parentIndex = 0;
        let parentElements = null;
        let selectors = [root.tagName.toLowerCase()];

        const pathLength = group[0].length;
        if (parentMap) {
            for (let i = 1; i < pathLength; i++) {
                if (parentMap.has(group[0][i])) {
                    parentIndex = i;
                }
            }
        }

        if (parentIndex) {
            const elements = Array.from(new Set(group.map(path => path[parentIndex])));
            parentElements = elements;
            selectors = parentMap.get(elements[0]);
        }

        let skippedTag = null;
        indexloop: for (let i = parentIndex + 1; i < pathLength; i++) {
            const elements = this.getGroupElementsAtIndex(group, i);
            const testSelectorLists = [];

            // check id selector
            if (elements.length === 1) {
                const id = elements[0].id;
                if (id && !parentElements) {
                    testSelectorLists.push(['#' + escapeCSS(id)]);
                }
            }

            const tagName = elements[0].tagName.toLowerCase();
            const classSelectors = this.getElementClassSelectors(elements);
            const allClassesSelector = tagName + classSelectors.join('');

            if (!generalize) {
                // check class selectors
                for (let classSelector of classSelectors) {
                    testSelectorLists.push([classSelector]);
                }

                // check tag selector
                if (!IMPLICIT_TAGS.has(tagName)) {
                    testSelectorLists.push([tagName]);
                }

                // check tag + class selector
                for (let classSelector of classSelectors) {
                    testSelectorLists.push([tagName + classSelector]);
                }
            }

            if (!IMPLICIT_TAGS.has(tagName)) {
                // nth-child
                const indices = this.getElementIndices(elements);

                if (indices.length > 1 && !generalize) {
                    // try to create an nth-child formula
                    let delta = indices[1] - indices[0];
                    let regularIndex = true;
                    for (let i = 2; i < indices.length; i++) {
                        if (indices[i] - indices[i - 1] !== delta) {
                            regularIndex = false;
                        }
                    }
                    if (regularIndex) {
                        const firstIndex = indices[0];
                        const lastIndex = indices[indices.length - 1];

                        if (delta === 1) {
                            delta = '';
                        }
                        testSelectorLists.push(
                            [`${tagName}:nth-child(${delta}n+${firstIndex})`],
                            [`${tagName}:nth-child(-${delta}n+${lastIndex})`],
                            [`${tagName}:nth-child(${delta}n+${firstIndex}):nth-child(-${delta}n+${lastIndex})`]);  // jshint ignore:line
                        for (let classSelector of classSelectors) {
                            testSelectorLists.push(
                                [`${classSelector}:nth-child(${delta}n+${firstIndex})`],
                                [`${classSelector}:nth-child(-${delta}n+${lastIndex})`],
                                [`${classSelector}:nth-child(${delta}n+${firstIndex}):nth-child(-${delta}n+${lastIndex})`]);  // jshint ignore:line
                            testSelectorLists.push(
                                [`${tagName}${classSelector}:nth-child(${delta}n+${firstIndex})`],
                                [`${tagName}${classSelector}:nth-child(-${delta}n+${lastIndex})`],
                                [`${tagName}${classSelector}:nth-child(${delta}n+${firstIndex}):nth-child(-${delta}n+${lastIndex})`]);  // jshint ignore:line
                        }
                    }
                }

                if (!generalize) {
                    // fail-safe explicitly listing all indices

                    let indexSelectors = [];
                    for (let index of indices) {
                        indexSelectors.push(`${tagName}:nth-child(${index})`);
                    }
                    testSelectorLists.push(indexSelectors);

                    for (let classSelector of classSelectors) {
                        let classIndexSelectors = [];
                        let tagIndexSelectors = [];
                        for (let index of indices) {
                            const classIndexSelector = `${classSelector}:nth-child(${index})`;
                            classIndexSelectors.push(classIndexSelector);
                            tagIndexSelectors.push(`${tagName}${classIndexSelector}`);
                        }
                        testSelectorLists.push(classIndexSelectors);
                        testSelectorLists.push(tagIndexSelectors);
                    }
                }

                if (generalize && indices.length === 1) {
                    testSelectorLists.push([`${allClassesSelector}:nth-child(${indices[0]})`]);
                }
            }

            if (generalize) {
                // fail-safe for generalized case
                testSelectorLists.push([allClassesSelector]);
            }

            if (!parentElements) {
                if (!generalize || elements.length === 1) {
                    for (let testSelectorList of testSelectorLists) {
                        const matches = root.querySelectorAll(
                            this.mergeSelectors(testSelectorList));
                        if (matches.length === elements.length) {
                            selectors = testSelectorList;
                            continue indexloop;
                        }
                    }
                }
            }

            for (let testSelectorList of testSelectorLists) {
                const concatSelectorList = [];
                for (let selector of selectors) {
                    for (let testSelector of testSelectorList) {
                        concatSelectorList.push(`${selector} > ${testSelector}`);
                    }
                }
                if (skippedTag) {
                    // since we can't know in browser if the skipped tag was present in the source
                    // markup we have at create a selector for both options like:
                    //     prefix > suffix, prefix > skipped > suffix
                    for (let selector of selectors) {
                        for (let testSelector of testSelectorList) {
                            concatSelectorList.push(
                                `${selector} > ${skippedTag} > ${testSelector}`);
                        }
                    }
                }
                const testSelector = this.mergeSelectors(concatSelectorList);
                let matches;
                if (parentElements) {
                    matches = new Set();
                    for (let parentElement of parentElements) {
                        for (let element of parentElement.querySelectorAll(testSelector)) {
                            matches.add(element);
                        }
                    }
                    matches = Array.from(matches);
                } else {
                    matches = root.querySelectorAll(testSelector);
                }
                if (generalize || matches.length === elements.length) {
                    selectors = concatSelectorList;
                    skippedTag = null;
                    continue indexloop;
                }
            }

            // we're here because we skipped a possibly implicitly added tag
            skippedTag = tagName;
        }

        // the final tag was skipped, we need to append it now
        if (skippedTag) {
            selectors = selectors.concat(...selectors.map(
                selector => `${selector} > ${skippedTag}`));
        }

        return selectors;
    },

    mergeSelectors(selectors) {
        while (Array.isArray(selectors)) {
            selectors = selectors.join(', ');
        }
        return selectors;
    },

    getGroupElementsAtIndex(group, index) {
        return Array.from(new Set(group.map(path => path[index])));
    },

    getElementClassSelectors(elements) {
        const classNameMap = new Map();
        const classSelectors = [];
        for (let element of elements) {
            if (!element.classList.length) {
                classNameMap.clear();
                break;
            }

            for (let className of Array.from(element.classList)) {
                classNameMap.set(className, (classNameMap.get(className) || 0) + 1);
            }
        }
        for (let [className, count] of classNameMap.entries()) {
            if (count === elements.length) {
                classSelectors.push('.' + escapeCSS(className));
            }
        }
        return classSelectors;
    },

    getElementIndices(elements) {
        return Array.from(new Set(elements.map(positionInParent))).sort((a, b) => a - b);
    },

    generalizationDistance(element) {
        const paths = this.get('paths');
        const groupedPaths = this.get('groupedPaths');
        const newPath = elementPath(element);
        const newGroupedPaths = this.groupPaths([newPath].concat(paths));

        if (newGroupedPaths.length > groupedPaths.length) {
            return Infinity;
        }

        const group = newGroupedPaths.find(group => group[0] === newPath);
        const pathLength = group[0].length;
        let distance = 0;
        let i = 0;
        const rejectElements = element => element === newPath[i];
        for (i = 0; i < pathLength; i++) {
            const elements = this.getGroupElementsAtIndex(group, i);
            if (elements.length === 1) {
                continue;
            }
            const currentElements = elements.reject(rejectElements);
            const newClassSelectors = this.getElementClassSelectors(elements);
            const currentClassSelectors = this.getElementClassSelectors(currentElements);
            if (currentClassSelectors.length > newClassSelectors.length) {
                if (newClassSelectors.length >= 1 &&
                        (currentClassSelectors.length - newClassSelectors.length === 1)) {
                    distance++;
                } else {
                    return Infinity;
                }
            }
            const newIndices = this.getElementIndices(elements);
            const currentIndices = this.getElementIndices(currentElements);
            if (currentIndices.length < newIndices.length) {
                distance++;
            }
        }
        return distance;
    }
});

export const AnnotationSelectorGenerator = BaseSelectorGenerator.extend({
    selectorMatcher: null,
    annotation: null,

    acceptElements: Ember.computed('annotation.acceptSelectors.[]', function() {
        const acceptSelectors = this.get('annotation.acceptSelectors');
        return this.get('selectorMatcher').query(this.mergeSelectors(acceptSelectors));
    }),
    rejectElements: Ember.computed('annotation.rejectSelectors.[]', function() {
        const rejectSelectors = this.get('annotation.rejectSelectors');
        return this.get('selectorMatcher').query(this.mergeSelectors(rejectSelectors));
    }),
    generalizedSelector: Ember.computed(
        'annotation.selectionMode', 'annotation.acceptSelectors.[]',
        'acceptElements.[]', 'rejectElements.[]', function() {
            if (this.get('annotation.selectionMode') === 'css') {
                const acceptSelectors = this.get('annotation.acceptSelectors');
                return this.mergeSelectors([acceptSelectors]);
            }

            const acceptElements = this.get('acceptElements');
            const paths = acceptElements.map(elementPath);
            const groupedPaths = this.groupPaths(paths);
            const selectors = this.createGeneralizedSelectors(groupedPaths);
            return this.mergeSelectors(selectors);
        }),
    elements: Ember.computed('generalizedSelector', function() {
        const selector = this.get('generalizedSelector');
        return this.get('selectorMatcher').query(selector);
    }),
    selector: Ember.computed(
        'selectors', 'annotation.selectionMode',
        'annotation.acceptSelectors.[]', 'acceptElements.[]', 'rejectElements.[]', function() {
            if (this.get('annotation.selectionMode') === 'css') {
                const acceptSelectors = this.get('annotation.acceptSelectors');
                if (acceptSelectors.length === 1) {
                    return this.mergeSelectors([acceptSelectors]);
                }

                const acceptElements = this.get('acceptElements');
                const acceptPaths = acceptElements.map(elementPath);
                const acceptGroupedPaths = this.groupPaths(acceptPaths);
                const newAcceptSelectors = this.createSelectors(acceptGroupedPaths);
                return this.mergeSelectors(newAcceptSelectors);
            }

            const selectors = this.get('selectors');
            const filteredSelectors = this.filterRejectedSelectors(selectors);
            return this.mergeSelectors(filteredSelectors);
        }),

    repeatedAnnotation: Ember.computed('selector', 'parent.repeatedContainers', function() {
        const parent = this.get('parent');
        if (!parent) {
            return false;
        }
        const selector = this.get('selector');
        const repeatedContainers = parent.get('repeatedContainers');
        const selectorMatcher = this.get('selectorMatcher');
        const elements = selectorMatcher.query(selector);
        if (!(selector && elements && elements.length > 1)) {
            return false;
        }
        if (repeatedContainers.length > 1) {
            for (let container of repeatedContainers) {
                let i = 0;
                for (let child of elements) {
                    if (container.contains(child)) {
                        i += 1;
                    }
                    if (i > 1) {
                        break;
                    }
                }
                if (i > 1) {
                    return true;
                }
            }
        }
        const container = parent.get('container');
        if (container) {
            const otherAnnotations = parent.get('parent.children').filter(s => s !== parent);
            return !otherAnnotations.any(a => a.get('container') === container);
        }
        return false;
    }),

    createGeneralizedSelectors(groupedPaths) {
        const selectors = groupedPaths.map(group => this.createGroupSelectors(group, null, true));
        return this.filterRejectedSelectors(selectors);
    },

    filterRejectedSelectors(selectors) {
        const selectorMatcher = this.get('selectorMatcher');
        const rejectElements = new Set(this.get('rejectElements'));
        return selectors.map(selectors => {
            // if the generalized selector contains a rejected element, create a new selector
            // that matches only the other elements
            const elements = Array.from(selectorMatcher.query(this.mergeSelectors(selectors)));
            const allowedElements = elements.filter(element => !rejectElements.has(element));
            if (elements.length === allowedElements.length) {
                return selectors;
            }
            const paths = allowedElements.map(elementPath);
            const allowedSelectors = this.createSelectors([paths]);
            return allowedSelectors[0];
        });
    }
});

export const ContainerSelectorGenerator = BaseSelectorGenerator.extend({
    init() {
        this._super(...arguments);
        this.set('children', []);
    },

    destroy() {
        for (let child of this.get('children')) {
            child.set('parent', null);
        }
        this.set('children', null);
        this._super(...arguments);
    },

    childElements: Ember.computed.mapBy('children', 'elements'),
    container: Ember.computed('childElements', function() {
        const childElements = this.get('childElements');
        return findContainer(childElements);
    }),
    containerSelector: Ember.computed('container', function() {
        const container = this.get('container');
        if (container) {
            const selectors = this.createSelectors([[elementPath(container)]]);
            return this.mergeSelectors(selectors);
        }
        return 'body';
    }),
    repeatedContainersAndSiblings: Ember.computed('childElements', 'container', function() {
        const childElements = this.get('childElements');
        const container = this.get('container');
        // TODO: support separated trees
        return findRepeatedContainers(childElements, container);
    }),
    repeatedContainers: Ember.computed.readOnly('repeatedContainersAndSiblings.firstObject'),
    siblings: Ember.computed.readOnly('repeatedContainersAndSiblings.lastObject'),
    elements: Ember.computed('container', 'repeatedContainers', function() {
        const container = this.get('container');
        const repeatedContainers = this.get('repeatedContainers');
        if (repeatedContainers.length) {
            return repeatedContainers;
        }
        if (container) {
            return [container];
        }
        return [];
    }),

    addChild(childGenerator) {
        this.get('children').addObject(childGenerator);
        childGenerator.set('parent', this);
    },

    addChildren(childGenerators) {
        const children = this.get('children');
        children.addObjects(childGenerators);
        for (let childGenerator of childGenerators) {
            childGenerator.set('parent', this);
        }
    }
});

export function setIntersection(a, b) {
    return new Set([...a].filter(x => b.has(x)));
}

export function setDifference(a, b) {
    return new Set([...a].filter(x => !b.has(x)));
}

export function getParents(element, upto) {
    var parents = [],
        parent = element.parentElement;
    while (parent) {
        parents.push(parent);
        parent = parent.parentElement;
        if (parent === upto) {
            return parents;
        }
    }
    return parents;
}

export function getPreviousSiblings(element, upto) {
    if (!element) {
        return [];
    }
    var siblings = [],
        sibling = element.previousElementSibling;
    while (sibling && sibling !== upto) {
        siblings.push(sibling);
        sibling = sibling.previousElementSibling;
    }
    return siblings;
}

export function closestParentIndex(element, parents) {
    if (parents === undefined) {
        parents = getParents(element);
        parents.unshift(element);
    }
    let elementIndex = parents.indexOf(element);
    if (elementIndex < 0) {
        return 0;
    }
    return parents.length - elementIndex;
}

export function findContainers(extractedElements, upto) {
    let parentArrays = [];
    for (let element of extractedElements) {
        parentArrays.push(getParents(element, upto));
    }
    let parentSets = parentArrays.map((array) => new Set(array)),
        intersection = parentSets[0] || new Set();
    for (let set of parentSets.slice(1, parentSets.length)) {
        intersection = setIntersection(intersection, set);
    }
    return Array.from(intersection);
}

export function findContainer(extractedElements) {
    return findContainers([].concat(...extractedElements))[0];
}

export function findRepeatedContainers(extracted, container) {
    let groupedItems = groupItems(extracted, container);
    if (groupedItems.length === 1) {
        return [[], 0];
    }
    let repeatedParents = groupedItems.map((item) => findContainers(item, container));
    if (repeatedParents.length === 0) {
        return [[], 0];
    }
    let allEqualLength = repeatedParents.isEvery('length', repeatedParents[0].length);
    if (allEqualLength &&
            new Set(repeatedParents.map((item) => item[0])).size === repeatedParents.length) {
        return [repeatedParents[0].length ? repeatedParents.map(list => list[0]) : [], 0];
    } else {
        let shortest = Math.min(...repeatedParents.map(e => e.length));
        repeatedParents = repeatedParents.map(
            (item) => item.slice(item.length - shortest, item.length));
        if (new Set(repeatedParents.map((item) => item[0])).size === repeatedParents.length) {
            return [repeatedParents[0].length ? repeatedParents.map(list => list[0]) : [], 0];
        }
    }
    return parentWithSiblings(groupedItems, container);
}

export function parentWithSiblings(groupedItems, container) {
    // 1. Get bounds
    let itemBounds = getItemBounds(groupedItems, false),
        itemParents = [],
        sharedItemParents = new Set(),
        sharedParents = new Set();
    // 2. Using highest and lowest parents remove any parents shared by other groups
    for (let [highest, lowest] of itemBounds) {
        itemParents.push([getParents(highest, container).reverse(),
                          getParents(lowest, container).reverse()]);
    }
    for (let fields of itemParents) {
        for (let fieldParents of fields) {
            for (let parent of fieldParents) {
                if (sharedItemParents.has(parent)) {
                    sharedParents.add(parent);
                } else {
                    sharedItemParents.add(parent);
                }
            }
        }
    }
    let i = 0;
    const filterNotShared = e => !sharedParents.has(e);
    for (let [highest, lowest] of itemParents) {
        itemParents[i] = [highest.filter(filterNotShared), lowest.filter(filterNotShared)];
        i += 1;
    }
    // TODO: Check if not siblings
    // 3. For each item find sibling distance between highest and lowest if they
    //    don't have a parent that isn't shared with other items. Use minimum
    let siblings = itemParents.map(
            (bounds) => getPreviousSiblings(bounds[1][0], bounds[0][0]).length + 1),
        siblingDistance = Math.min(...siblings);
    // 5. Use the highest unshared parent of the highest field of the first item
    //    as the repeating container
    const containers = itemParents.map(lists => lists[0][0])
        // remove undefined
        .filter(containers => !!containers);
    return [containers, siblingDistance];
}

function getItemBounds(items, tagNumber=true) {
    let elementMap = {};
    return items.map(function(elements) {
            let tagids = [];
            for (let element of elements) {
                // TODO: Find incrementing id from dom nodes rather than
                //       attribute added by backend
                let tagid = element.getAttribute('data-tagid');
                if (tagid) {
                    tagid = parseInt(tagid);
                    tagids.push(tagid);
                    elementMap[tagid] = element;
                }
            }
            if (tagNumber) {
                return [Math.min(...tagids), Math.max(...tagids)];
            }
            return [elementMap[Math.min(...tagids)],
                    elementMap[Math.max(...tagids)]];
    });
}

export function groupItems(extracted, upto) {
    let groups = {},
        id = 0;
    // Group fields based on their color
    // TODO: Group by schema too
    for (let elements of extracted) {
        groups[id] = elements;
        id += 1;
    }
    // If all groups are the same length page hass a regular structure where
    // all items have the necessary fields and share a common repeating parent
    let groupLengths = new Set(Object.keys(groups).map((key) => groups[key].length));
    if (groupLengths.size === 1) {
        return makeItemsFromGroups(groups);
    }
    let longest = Math.max(...groupLengths),
        longestGroups = {},
        otherGroups = {};
    for (let key in groups) {
        if (groups[key].length === longest) {
            longestGroups[key] = groups[key];
        } else {
            otherGroups[key] = groups[key];
        }
    }
    // Find bounding tagids for each item
    let items = makeItemsFromGroups(longestGroups),
        itemBounds = getItemBounds(items);
    let remainingFields = {};
    let i = 0,
        seenElements = new Set();
    // Place bounded elements into corresponding items and
    // find parents for unbounded fields
    for (let fieldKey in otherGroups) {
        let fieldGroup = otherGroups[fieldKey];
        for (let element of fieldGroup) {
            i = 0;
            for (let [min, max] of itemBounds) {
                let tagid = parseInt(element.getAttribute('data-tagid'));
                if (tagid && tagid > min && tagid < max) {
                    items[i].push(element);
                    seenElements.add(element);
                    break;
                }
                i += 1;
            }
            if (!seenElements.has(element)) {
                if (remainingFields[fieldKey]) {
                    remainingFields[fieldKey].push([element, getParents(element, upto)]);
                } else {
                    remainingFields[fieldKey] = [[element, getParents(element, upto)]];
                }
            }
        }
    }
    // Find parents for each field in an item for all items
    let itemsParents = [];
    for (let item of items) {
        let itemParents = [];
        for (let element of item) {
            itemParents = itemParents.concat(getParents(element, upto));
        }
        let parentCount = [],
            seenParents = [],
            orderedParents = [];
        for (let parent of itemParents) {
            let parentIdx = seenParents.indexOf(parent);
            if (parentIdx > 0) {
                parentCount[parentIdx] += 1;
            } else {
                parentCount.push(1);
                seenParents.push(parent);
            }
        }
        // Order parents by ones with the most descendant fields
        for (i=0; i < seenParents.length; i++) {
            orderedParents.push([parentCount[i], seenParents[i]]);
        }
        itemParents = [];
        for (let parent of orderedParents.sort()) {
            itemParents.push(parent[1]);
        }
        itemsParents.push(new Set(itemParents));
    }
    // Remove parents shared by multiple items
    let uniqueParents = [];
    for (let parents of itemsParents) {
        for (let otherParents of itemsParents) {
            if (otherParents === parents) {
                continue;
            }
            parents = setDifference(parents, otherParents);
        }
        uniqueParents.push(parents);
    }
    i = 0;
    for (let itemParents of uniqueParents) {
        for (let key in remainingFields) {
            for (let [element, elementParents] of remainingFields[key]) {
                for (let parent of elementParents) {
                    if (itemParents.has(parent)) {
                        items[i].push(element);
                        break;
                    }
                }
            }
        }
        i += 1;
    }
    // TODO: Fields that are not in all items and are below the item bounds still
    //       need to be matched -> all tests pass without this, need a breaking test
    return items;
}

export function makeItemsFromGroups(groups) {
    let items = [];
    for (let key of Object.keys(groups)) {
        for (let [i, item] of groups[key].entries()) {
            if (!items[i]) {
                items[i] = [];
            }
            items[i].push(item);
        }
    }
    return items;
}

function createSelectorGenerators(structure, selectorMatcher, accumulator) {
    const generators = [];

    for (let element of structure) {
        const {annotation, children} = element;
        let selectorGenerator;
        if (children) {
            selectorGenerator = ContainerSelectorGenerator.create({});
            selectorGenerator.addChildren(
                createSelectorGenerators(children, selectorMatcher, accumulator));

        } else {
            selectorGenerator = AnnotationSelectorGenerator.create({
                selectorMatcher,
                annotation
            });
        }
        generators.push(selectorGenerator);
        accumulator.push([annotation, selectorGenerator]);
    }

    return generators;
}

export function updateStructureSelectors(structure, selectorMatcher) {
    const accumulator = [];
    createSelectorGenerators(structure, selectorMatcher, accumulator);
    for (let [annotation, selectorGenerator] of accumulator) {
        const selector = selectorGenerator.get('selector');
        if (selectorGenerator instanceof AnnotationSelectorGenerator) {
            annotation.setProperties({
                selector,
                xpath: selectorGenerator.get('xpath')
            });
            if (annotation.get('selectionMode') === 'css') {
                annotation.setSelector(selector);
            }
        } else if (selectorGenerator instanceof ContainerSelectorGenerator) {
            const containerSelector = selectorGenerator.get('containerSelector');
            const siblings = selectorGenerator.get('siblings');
            const element = selector ? selectorMatcher.query(selector) : [];
            if (!element.length) {
                annotation.setProperties({
                    selector: null,
                    repeatedSelector: null,
                    siblings: 0
                });
            } else if (element.length > 1) {
                annotation.setProperties({
                    selector: containerSelector,
                    repeatedSelector: selector,
                    siblings
                });
            } else {
                annotation.setProperties({
                    selector,
                    repeatedSelector: null,
                    siblings
                });
            }
        }
        selectorGenerator.destroy();
    }
}

export default {
    BaseSelectorGenerator,
    AnnotationSelectorGenerator,
    ContainerSelectorGenerator,
    pathSelector,
    uniquePathSelector,
    smartSelector,
    cssToXpath,
    findContainer,
    findRepeatedContainers,
    updateStructureSelectors
};
