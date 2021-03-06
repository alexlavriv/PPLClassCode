// L5-typeinference

import * as R from "ramda";
import * as A from "./L5-ast";
import * as TC from "./L5-typecheck";
import * as E from "./TEnv";
import * as T from "./TExp";
import { getErrorMessages, hasNoError, isError } from "./error";
import { allT, first, rest, second } from "./list";

// Purpose: Make type expressions equivalent by deriving a unifier
// Return an error if the types are not unifiable.
// Exp is only passed for documentation purposes.
const checkEqualType = (te1: T.TExp | Error, te2: T.TExp | Error, exp: A.Exp): true | Error =>
    isError(te1) ? te1 :
    isError(te2) ? te2 :
    (T.isTVar(te1) && T.isTVar(te2)) ? ((T.eqTVar(te1, te2) ? true : checkTVarEqualTypes(te1, te2, exp))) :
    (T.isTVar(te1)) ? checkTVarEqualTypes(te1, te2, exp) :
    (T.isTVar(te2)) ? checkTVarEqualTypes(te2, te1, exp) :
    ((T.isAtomicTExp(te1) && T.isAtomicTExp(te2))) ?
        ((T.eqAtomicTExp(te1, te2)) ? true : Error(`Incompatible atomic types ${T.unparseTExp(te1)} - ${T.unparseTExp(te2)}`)) :
    (T.isProcTExp(te1) && T.isProcTExp(te2)) ? checkProcEqualTypes(te1, te2, exp) :
    Error(`Incompatible types structure: ${T.unparseTExp(te1)} - ${T.unparseTExp(te2)}`);

// Purpose: make two lists of equal length of type expressions equal
// Return an error if one of the pair of TExps are not compatible - true otherwise.
// Exp is only passed for documentation purposes.
const checkEqualTypes = (tes1: T.TExp[], tes2: T.TExp[], exp: A.Exp): true | Error => {
    const checks = R.zipWith((te1, te2) => checkEqualType(te1, te2, exp), tes1, tes2);
    if (hasNoError(checks))
        return true;
    else
        return Error(`Check ${A.unparse(exp)}: errors ${getErrorMessages(checks)}`);
}

const checkProcEqualTypes = (te1: T.ProcTExp, te2: T.ProcTExp, exp: A.Exp): true | Error =>
    (te1.paramTEs.length !== te2.paramTEs.length) ? Error(`Wrong number of args ${T.unparseTExp(te1)} - ${T.unparseTExp(te2)}`) :
    checkEqualTypes(T.procTExpComponents(te1), T.procTExpComponents(te2), exp);

// Purpose: check that a type variable matches a type expression
// Updates the var is needed to refer to te.
// Exp is only passed for documentation purposes.
const checkTVarEqualTypes = (tvar: T.TVar, te: T.TExp, exp: A.Exp): true | Error => {
    if (T.tvarIsNonEmpty(tvar))
        return checkEqualType(T.tvarContents(tvar), te, exp);
    else {
        const v1 = checkNoOccurrence(tvar, te, exp);
        if (isError(v1))
            return v1;
        else {
            T.tvarSetContents(tvar, te);
            return true;
        }
    }
}

// Purpose: when attempting to bind tvar to te - check whether tvar occurs in te.
// Throws error if a circular reference is found.
// Exp is only passed for documentation purposes.
// Pre-conditions: Tvar is not bound
const checkNoOccurrence = (tvar: T.TVar, te: T.TExp, exp: A.Exp): true | Error => {
    const checkList = (tes: T.TExp[]): true | Error => {
        const c = R.map(loop, tes);
        if (hasNoError(c))
            return true;
        else
            return Error(getErrorMessages(c));
    }
    const loop = (te1: T.TExp): true | Error =>
        T.isAtomicTExp(te1) ? true :
        T.isProcTExp(te1) ? checkList(T.procTExpComponents(te1)) :
        T.isTVar(te1) ? (T.eqTVar(te1, tvar) ? Error(`Occur check error - ${te1.var} - ${tvar.var} in ${A.unparse(exp)}`) : true) :
        Error(`Bad type expression - ${JSON.stringify(te1)} in ${A.unparse(exp)}`);
    return loop(te);
}

// Compute the type of Typed-AST exps to TE
// ========================================
// Compute a Typed-AST exp to a Texp on the basis of its structure and the annotations it contains.

// Purpose: Compute the type of a concrete fully-typed expression
export const inferTypeOf = (conceteExp: string): string | Error =>
    T.unparseTExp(typeofExp(A.parse(conceteExp), E.makeEmptyTEnv()));

// Purpose: Compute the type of an expression
// Traverse the AST and check the type according to the exp type.
export const typeofExp = (exp: A.Parsed | Error, tenv: E.TEnv): T.TExp | Error =>
    A.isNumExp(exp) ? T.makeNumTExp() :
    A.isBoolExp(exp) ? T.makeBoolTExp() :
    A.isStrExp(exp) ? T.makeStrTExp() :
    A.isPrimOp(exp) ? TC.typeofPrim(exp) :
    A.isVarRef(exp) ? E.applyTEnv(tenv, exp.var) :
    A.isIfExp(exp) ? typeofIf(exp, tenv) :
    A.isProcExp(exp) ? typeofProc(exp, tenv) :
    A.isAppExp(exp) ? typeofApp(exp, tenv) :
    A.isLetExp(exp) ? typeofLet(exp, tenv) :
    A.isLetrecExp(exp) ? typeofLetrec(exp, tenv) :
    A.isDefineExp(exp) ? typeofDefine(exp, tenv) :
    A.isProgram(exp) ? typeofProgram(exp, tenv) :
    // Skip isSetExp(exp) isLitExp(exp)
    Error("Unknown type");

// Purpose: Compute the type of a sequence of expressions
// Signature: typeof-exps(exps, tenv)
// Type: [List(Cexp) * Tenv -> Texp]
// Check all the exps in a sequence - return type of last.
// Pre-conditions: exps is not empty.
const typeofExps = (exps: A.Exp[], tenv: E.TEnv): T.TExp | Error =>
    A.isEmpty(rest(exps)) ? typeofExp(first(exps), tenv) :
    isError(typeofExp(first(exps), tenv)) ? typeofExp(first(exps), tenv) :
    typeofExps(rest(exps), tenv);

// Purpose: compute the type of an if-exp
// Typing rule:
//   if type<test>(tenv) = boolean
//      type<then>(tenv) = t1
//      type<else>(tenv) = t1
// then type<(if test then else)>(tenv) = t1
const typeofIf = (ifExp: A.IfExp, tenv: E.TEnv): T.TExp | Error => {
    const testTE = typeofExp(ifExp.test, tenv);
    const thenTE = typeofExp(ifExp.then, tenv);
    const altTE = typeofExp(ifExp.alt, tenv);
    const constraint1 = checkEqualType(testTE, T.makeBoolTExp(), ifExp);
    const constraint2 = checkEqualType(thenTE, altTE, ifExp);
    if (isError(constraint1))
        return constraint1;
    else if (isError(constraint2))
        return constraint2;
    else
        return thenTE;
};

// Purpose: compute the type of a proc-exp
// Typing rule:
// If   type<body>(extend-tenv(x1=t1,...,xn=tn; tenv)) = t
// then type<lambda (x1:t1,...,xn:tn) : t exp)>(tenv) = (t1 * ... * tn -> t)
export const typeofProc = (proc: A.ProcExp, tenv: E.TEnv): T.TExp | Error => {
    const argsTEs = R.map((vd) => vd.texp, proc.args);
    const extTEnv = E.makeExtendTEnv(R.map((vd) => vd.var, proc.args), argsTEs, tenv);
    const constraint1 = checkEqualType(typeofExps(proc.body, extTEnv), proc.returnTE, proc);
    if (isError(constraint1))
        return constraint1;
    else
        return T.makeProcTExp(argsTEs, proc.returnTE);
};


// Purpose: compute the type of an app-exp
// Typing rule:
// If   type<rator>(tenv) = (t1*..*tn -> t)
//      type<rand1>(tenv) = t1
//      ...
//      type<randn>(tenv) = tn
// then type<(rator rand1...randn)>(tenv) = t
// NOTE: This procedure is different from the one in L5-typecheck
export const typeofApp = (app: A.AppExp, tenv: E.TEnv): T.TExp | Error => {
    const ratorTE = typeofExp(app.rator, tenv);
    if (isError(ratorTE)) return ratorTE;
    const randsTE = R.map((rand) => typeofExp(rand, tenv), app.rands);
    if (! hasNoError(randsTE)) return Error(getErrorMessages(randsTE));
    const returnTE = T.makeFreshTVar();
    const constraint = checkEqualType(ratorTE, T.makeProcTExp(randsTE, returnTE), app);
    if (isError(constraint))
        return constraint;
    else
        return returnTE;
};

// Purpose: compute the type of a let-exp
// Typing rule:
// If   type<val1>(tenv) = t1
//      ...
//      type<valn>(tenv) = tn
//      type<body>(extend-tenv(var1=t1,..,varn=tn; tenv)) = t
// then type<let ((var1 val1) .. (varn valn)) body>(tenv) = t
export const typeofLet = (exp: A.LetExp, tenv: E.TEnv): T.TExp | Error => {
    const vars = R.map((b) => b.var.var, exp.bindings);
    const vals = R.map((b) => b.val, exp.bindings);
    const varTEs = R.map((b) => b.var.texp, exp.bindings);
    const constraints = R.zipWith((varTE, val) => checkEqualType(varTE, typeofExp(val, tenv), exp),
                                  varTEs, vals);
    if (hasNoError(constraints))
        return typeofExps(exp.body, E.makeExtendTEnv(vars, varTEs, tenv));
    else
        return Error(getErrorMessages(constraints));
};

// Purpose: compute the type of a letrec-exp
// We make the same assumption as in L4 that letrec only binds proc values.
// Typing rule:
//   (letrec((p1 (lambda (x11 ... x1n1) body1)) ...) body)
//   tenv-body = extend-tenv(p1=(t11*..*t1n1->t1)....; tenv)
//   tenvi = extend-tenv(xi1=ti1,..,xini=tini; tenv-body)
// If   type<body1>(tenv1) = t1
//      ...
//      type<bodyn>(tenvn) = tn
//      type<body>(tenv-body) = t
// then type<(letrec((p1 (lambda (x11 ... x1n1) body1)) ...) body)>(tenv-body) = t
export const typeofLetrec = (exp: A.LetrecExp, tenv: E.TEnv): T.TExp | Error => {
    const ps = R.map((b) => b.var.var, exp.bindings);
    const procs = R.map((b) => b.val, exp.bindings);
    if (! allT(A.isProcExp, procs))
        return Error(`letrec - only support binding of procedures - ${A.unparse(exp)}`);
    const paramss = R.map((p) => p.args, procs);
    const bodies = R.map((p) => p.body, procs);
    const tijs = R.map((params) => R.map((p) => p.texp, params), paramss);
    const tis = R.map((proc) => proc.returnTE, procs);
    const tenvBody = E.makeExtendTEnv(ps, R.zipWith((tij, ti) => T.makeProcTExp(tij, ti), tijs, tis), tenv);
    const tenvIs = R.zipWith((params, tij) => E.makeExtendTEnv(R.map((p) => p.var, params), tij, tenvBody),
                             paramss, tijs);
    // Unfortunately ramda.zipWith does not work with 3 params
    const constraints = R.zipWith((bodyI, ti_tenvI) =>
                                      checkEqualType(typeofExps(bodyI, second(ti_tenvI)), first(ti_tenvI), exp),
                                bodies, R.zip(tis, tenvIs));
    if (hasNoError(constraints))
        return typeofExps(exp.body, tenvBody);
    else
        return Error(getErrorMessages(constraints));
};


// Purpose: compute the type of a define
// Typing rule:
//   (define (var : texp) val)
// TODO - write the true definition
export const typeofDefine = (exp: A.DefineExp, tenv: E.TEnv): T.TExp | Error => {
    // return Error("TODO");
    return T.makeVoidTExp();
};

// Purpose: compute the type of a program
// Typing rule:
// TODO - write the true definition
export const typeofProgram = (exp: A.Program, tenv: E.TEnv): T.TExp | Error => {
    return Error("TODO");
};

