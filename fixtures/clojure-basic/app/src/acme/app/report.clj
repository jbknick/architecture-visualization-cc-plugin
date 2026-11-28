(ns acme.app.report
  (:require [acme.core.shapes :refer [describe]]))

(defn print-report [shapes]
  (doseq [s shapes]
    (println (describe s))))
