(ns acme.core.util)

(defn clamp [x lo hi]
  (max lo (min hi x)))

(defn square [x] (* x x))

(defn round-to
  ([x] (round-to x 1))
  ([x step]
   ;; A local named like a function of the namespace: the call below is no call of `clamp`.
   (let [clamp step]
     (* clamp (Math/round (/ x clamp))))))

#?(:clj (def platform :jvm)
   :cljs (def platform :js))
