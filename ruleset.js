const {filter, forEach, map} = require('wu');

const {Fnode} = require('./fnode');
const {setDefault} = require('./utils');
const {out, OutwardRhs} = require('./rhs');


// Construct and return the proper type of rule class based on the
// inwardness/outwardness of the RHS.
function rule(lhs, rhs) {
    // Since out() is a valid call only on the RHS (unlike type()), we can take
    // a shortcut here: any outward RHS will already be an OutwardRhs; we don't
    // need to sidetrack it through being a Side. And OutwardRhs has an asRhs()
    // that just returns itself.
    return new ((rhs instanceof OutwardRhs) ? OutwardRule : InwardRule)(lhs, rhs);
}


// Sugar for conciseness and consistency
function ruleset(...rules) {
    return new Ruleset(...rules);
}


// An unbound ruleset. Eventually, you'll be able to add rules to these. Then,
// when you bind them by calling against(), the resulting BoundRuleset will be
// immutable.
class Ruleset {
    constructor(...rules) {
        this._inRules = [];
        this._outRules = new Map();

        // Separate rules into out ones and in ones, and sock them away. We do
        // this here so mistakes raise errors early.
        for (let rule of rules) {
            if (rule instanceof InwardRule) {
                this._inRules.push(rule);
            } else if (rule instanceof OutwardRule) {
                this._outRules.set(rule.key(), rule);
            } else {
                throw new Error(`This input to ruleset() wasn't a rule: ${rule}`);
            }
        }
    }

    against(doc) {
        return new BoundRuleset(doc, this._inRules, this._outRules);
    }
}


// A ruleset that is earmarked to analyze a certain DOM
//
// This also carries with it a cache of rule results.
class BoundRuleset {
    // inRules: an Array of non-out() rules
    // outRules: a Map of output keys to out() rules
    constructor(doc, inRules, outRules) {
        this.doc = doc;
        this._inRules = inRules;
        this._outRules = outRules;

        // Private, for the use of only helper classes:
        this.ruleCache = new Map();  // Rule instance => Array of result fnodes or out.through() return values
        this.maxCache = new Map();  // type => Array of max fnode (or fnodes, if tied) of this type
        this.typeCache = new Map();  // type => Array of all fnodes of this type
        this.elementCache = new Map();  // DOM element => fnode about it
    }

    // Return an array of zero or more results.
    // thing: can be...
    //   * A string which matches up with an "out" rule in the ruleset. In this
    //     case, fnodes will be returned. Or, if the out rule referred to uses
    //     through(), whatever the results of through's callback will be
    //     returned.
    //   * (Experimental) An arbitrary LHS which we'll calculate and return the
    //     results of. In this case, fnodes will be returned. (Note: LHSs
    //     passed in like this will be taken as part of the ruleset in future
    //     calls.)
    //   * A DOM node, which will (inefficiently) run the whole ruleset and
    //     return the fully annotated fnode corresponding to that node
    // Results are cached in the first and third cases.
    get(thing) {
        if (typeof thing === 'string') {
            if (this._outRules.has(thing)) {
                return Array.from(this._outRules.get(thing).results(this));
            } else {
                throw new Error(`There is no out() rule with key "${thing}".`);
            }
        } else if (thing.nodeName !== undefined) {
            // Compute everything (not just things that lead to outs):
            for (let rule of this._inRules) {
                rule.results(this);
            }
            return this.fnodeForElement(thing);
            // TODO: How can we be more efficient about this, for classifying
            // pages (in which case the classifying types end up attached to a
            // high-level element like <html>)? Maybe we care only about some
            // of the classification types in this ruleset: let's not run the
            // others. We could provide a predefined partial RHS that specifies
            // element(root) and a convenience routine that runs .get(each
            // classification type) and then returns the root fnode, which you
            // can examine to see what types are on it.
        } else if (thing.asLhs) {
            // Make a temporary out rule, and run it. This may add things to
            // the ruleset's cache, but that's fine: it doesn't change any
            // future results; it just might make them faster. For example, if
            // you ask for .get(type('smoo')) twice, the second time will be a
            // cache hit.
            const outRule = rule(thing, out(Symbol('outKey')));
            return Array.from(outRule.results(this));
        } else {
            throw new Error('ruleset.get() expects a string, an expression like on the left-hand side of a rule, or a DOM node.');
        }
    }

    // Provide an opaque context object to be made available to all ranker
    // functions.
    // context (object) {
    //     self.context = object;
    // }

    // -------- Methods below this point are private to the framework. --------

    // Return an iterable of rules which might add a given type to fnodes.
    // We return any rule we can't prove doesn't add the type. None, it
    // follows, are OutwardRules. Also, note that if a rule both takes and
    // emits a certain type, it is not considered to "add" it.
    rulesWhichMightAdd(type) {
        // The work this does is cached in this.typeCache by the Lhs.
        return filter(rule => rule.mightAdd(type), this._inRules);
    }

    // Return the Fathom node that describes the given DOM element.
    fnodeForElement(element) {
        return setDefault(this.elementCache,
                          element,
                          () => new Fnode(element));
    }
}


// We place the in/out distinction in Rules because it determines whether the
// RHS result is cached, and Rules are responsible for maintaining the rulewise
// cache ruleset.ruleCache.
class Rule {  // abstract
    constructor(lhs, rhs) {
        this.lhs = lhs.asLhs();
        this.rhs = rhs.asRhs();
    }
}


// A normal rule, whose results head back into the Fathom knowledgebase, to be
// operated on by further rules.
class InwardRule extends Rule {
    // Return the fnodes emitted by the RHS of this rule.
    results(ruleset) {
        const self = this;
        // This caches the fnodes emitted by the RHS result of a rule. Any more
        // fine-grained caching is the responsibility of the delegated-to
        // results() methods. For now, we consider most of what a LHS computes
        // to be cheap, aside from type() and type().max(), which are cached by
        // their specialized LHS subclasses.
        return setDefault(
            ruleset.ruleCache,
            this,
            function computeFnodes() {
                const leftFnodes = self.lhs.fnodes(ruleset);
                // Avoid returning a single fnode more than once. LHSs uniquify
                // themselves, but the RHS can change the element it's talking
                // about and thus end up with dupes.
                const returnedFnodes = new Set();

                // Merge facts into fnodes:
                forEach(
                    function updateFnode(leftFnode) {
                        const fact = self.rhs.fact(leftFnode);
                        self.lhs.checkFact(fact);
                        const rightFnode = ruleset.fnodeForElement(fact.element || leftFnode.element);
                        // If the RHS doesn't specify a type, default to the
                        // type of the LHS, if any:
                        const rightType = fact.type || self.lhs.guaranteedType();
                        if (fact.conserveScore) {
                            // If conserving, multiply in the input-type score
                            // from the LHS node. (Never fall back to
                            // multiplying in the RHS-type score from the LHS:
                            // it's not guaranteed to be there, and even if it
                            // will ever be, the executor doesn't guarantee it
                            // has been filled in yet.)
                            const leftType = self.lhs.guaranteedType();
                            if (leftType !== undefined) {
                                rightFnode.conserveScoreFrom(leftFnode, leftType, rightType);
                            } else {
                                throw new Error('conserveScore() was called in a rule whose left-hand side is a dom() selector and thus has no predictable type.');
                            }
                        }
                        if (fact.score !== undefined) {
                            if (rightType !== undefined) {
                                rightFnode.multiplyScore(rightType, fact.score);
                            } else {
                                throw new Error(`The right-hand side of a rule specified a score (${fact.score}) with neither an explicit type nor one we could infer from the left-hand side.`);
                            }
                        }
                        if (fact.type !== undefined || fact.note !== undefined) {
                            // There's a reason to call setNote.
                            if (rightType === undefined) {
                                throw new Error(`The right-hand side of a rule specified a note (${fact.note}) with neither an explicit type nor one we could infer from the left-hand side. Notes are per-type, per-node, so that's a problem.`);
                            } else {
                                rightFnode.setNote(rightType, fact.note);
                            }
                        }
                        returnedFnodes.add(rightFnode);
                    },
                    leftFnodes);

                return Array.from(returnedFnodes.values());  // TODO: Use unique().
            });
    }

    // Return false if we can prove I never add the given type to fnodes.
    // Otherwise, return true.
    mightAdd(type) {
        const inputType = this.lhs.guaranteedType();
        const outputTypes = this.rhs.possibleTypes();

        if (type === inputType) {
            // Can't *add* a type that's already on the incoming fnodes
            return false;
        }
        if (outputTypes.size > 0) {
            return outputTypes.has(type);
        }
        return true;
    }
}


// A rule whose RHS is an out(). This represents a final goal of a ruleset.
// Its results go out into the world, not inward back into the Fathom
// knowledgebase.
class OutwardRule extends Rule {
    // Compute the whole thing, including any .through().
    results(ruleset) {
        return setDefault(
            ruleset.ruleCache,
            this,
            () => map(this.rhs.through, this.lhs.fnodes(ruleset)));
    }

    // Return the key under which the output of this rule will be available.
    key() {
        return this.rhs.key;
    }
}


module.exports = {
    rule,
    ruleset
};
