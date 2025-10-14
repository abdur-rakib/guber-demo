import { Job } from "bullmq"
import { countryCodes, dbServers, EngineType } from "../config/enums"
import { ContextType } from "../libs/logger"
import { jsonOrStringForDb, jsonOrStringToJson, stringOrNullForDb, stringToHash } from "../utils"
import _ from "lodash"
import { sources } from "../sites/sources"
import items from "./../../local-json/pharmacyItems.json"
import connections from "./../../local-json/brandConnections.json"

type BrandsMapping = {
    [key: string]: string[]
}

// Noise words
const NOISE_WORDS = ["bio", "neb"]
// Brands that MUST appear at the beginning
const FRONT_ONLY_BRANDS = [
    "rich", "rff", "flex", "ultra", "gum", 
    "beauty", "orto", "free", "112", "kin", "happy"
]
// Brands that MUST appear at the beginning or second position
const FRONT_OR_SECOND_BRANDS = ["heel", "contour", "nero", "rsv"]
// case sensitive brands
const CASE_SENSITIVE_BRANDS = ["HAPPY"]

/**
 * Checks if brand meets position requirements
 * Some brands are only valid at specific positions in the title
 */
function checkBrandPosition(title: string, brand: string): boolean {
    const words = title.split(/\s+/)
    
    // Rule 3: Must be at front (position 0)
    if (FRONT_ONLY_BRANDS.includes(brand)) {
        return words[0] === brand
    }
    
    // Rule 4: Must be at front OR second position (0 or 1)
    if (FRONT_OR_SECOND_BRANDS.includes(brand)) {
        return words[0] === brand || words[1] === brand
    }
    
    // If not position-sensitive, allow anywhere
    return true
}

/**
 * When multiple brands match, prioritize the one that appears first in title
 */
function prioritizeBrandsByPosition(
    matchedBrands: string[], 
    originalTitle: string
): string[] {
    return matchedBrands.sort((brandA, brandB) => {
        const normalizedTitle = normalizeBrandName(originalTitle)
        const posA = normalizedTitle.indexOf(normalizeBrandName(brandA))
        const posB = normalizedTitle.indexOf(normalizeBrandName(brandB))
        
        // Sort by position (earliest first)
        return posA - posB
    })
}

/**
 * Removes noise words from product title before brand matching
 * Example: "BIO Bayer Aspirin" -> "Bayer Aspirin"
 */
function removeNoiseWords(title: string): string {
    let cleanedTitle = title
    NOISE_WORDS.forEach(noiseWord => {
        // Remove noise word with word boundaries (case-insensitive)
        const regex = new RegExp(`\\b${noiseWord}\\b`, "gi")
        cleanedTitle = cleanedTitle.replace(regex, "").trim()
    })
    // Clean up multiple spaces
    return cleanedTitle.replace(/\s+/g, " ").trim()
}

/**
 * Selects a single canonical brand from a group of related brands
 * This ensures that all products in the same brand group get assigned the same canonical brand
 * 
 * Strategy: Pick the shortest brand name for consistency
 * Example: ["baff-bombz", "zimpli kids"] -> always returns "baff-bombz" (shorter)
 * 
 * @param matchedBrands Array of brands that matched the product title
 * @param brandsMapping The complete brand mapping to find all related brands
 * @returns Single canonical brand name
 */
function getCanonicalBrand(
    matchedBrands: string[], 
    brandsMapping: BrandsMapping
): string {
    if (matchedBrands.length === 1) return matchedBrands[0]
    
    // Collect all brands in the same group(s)
    const brandGroup = new Set<string>()
    
    matchedBrands.forEach(brand => {
        // Add the brand itself
        brandGroup.add(brand)
        
        // Add all its related brands to get the complete group
        if (brandsMapping[brand]) {
            brandsMapping[brand].forEach(relatedBrand => {
                brandGroup.add(relatedBrand)
            })
        }
    })
    
    // Convert to array and sort by:
    // 1. Length (shortest first - more concise brand names preferred)
    // 2. Alphabetically (for consistent ordering when lengths are equal)
    const sortedBrands = Array.from(brandGroup).sort((a, b) => {
        // Primary sort: by length (shorter is better)
        if (a.length !== b.length) {
            return a.length - b.length
        }
        // Secondary sort: alphabetically (for deterministic results)
        return a.localeCompare(b)
    })
    
    // Return the canonical brand (shortest, or alphabetically first if tied)
    return sortedBrands[0]
}

export async function getBrandsMapping(): Promise<BrandsMapping> {
    const brandConnections = connections

    // Create a map to track brand relationships
    const brandMap = new Map<string, Set<string>>()

    brandConnections.forEach(({ manufacturer_p1, manufacturers_p2 }) => {
        const brand1 = manufacturer_p1.toLowerCase()
        const brands2 = manufacturers_p2.toLowerCase()
        const brand2Array = brands2.split(";").map((b) => b.trim())
        if (!brandMap.has(brand1)) {
            brandMap.set(brand1, new Set())
        }
        brand2Array.forEach((brand2) => {
            if (!brandMap.has(brand2)) {
                brandMap.set(brand2, new Set())
            }
            brandMap.get(brand1)!.add(brand2)
            brandMap.get(brand2)!.add(brand1)
        })
    })

    // Convert the flat map to an object for easier usage
    const flatMapObject: Record<string, string[]> = {}

    brandMap.forEach((relatedBrands, brand) => {
        flatMapObject[brand] = Array.from(relatedBrands)
    })

    return flatMapObject
}

async function getPharmacyItems(countryCode: countryCodes, source: sources, versionKey: string, mustExist = true) {
    const finalProducts = items

    return finalProducts
}

/**
 * Normalizes special characters in brand names for matching
 * Example: "Babē" -> "Babe", "Müller" -> "Muller"
 */
function normalizeBrandName(brand: string): string {
    return brand
        .normalize("NFD") // Decompose characters
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
        .toLowerCase()
        .trim()
}

export function checkBrandIsSeparateTerm(input: string, brand: string): boolean {
     // Rule 1: Normalize characters
    const normalizedInput = normalizeBrandName(input)
    const normalizedBrand = normalizeBrandName(brand)

    // Rule 6: Handle case-sensitive brands
    if (CASE_SENSITIVE_BRANDS.includes(brand)) {
        const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const matchFound = new RegExp(`\\b${escapedBrand}\\b`).test(input)
        
        if (!matchFound) return false
        
        // Check position rules
        return checkBrandPosition(normalizedInput, normalizedBrand)
    }

    // Escape any special characters in the brand name for use in a regular expression
    const escapedBrand = normalizedBrand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    // Check if the brand is at the beginning or end of the string
    const atBeginningOrEnd = new RegExp(
        `^(?:${escapedBrand}\\s|.*\\s${escapedBrand}\\s.*|.*\\s${escapedBrand})$`,
        "i"
    ).test(normalizedInput)

    // Check if the brand is a separate term in the string
    const separateTerm = new RegExp(`\\b${escapedBrand}\\b`, "i").test(normalizedInput)
    
    const matchFound = atBeginningOrEnd || separateTerm
    
    if (!matchFound) return false
    
    // Rules 3 & 4: Check position requirements
    return checkBrandPosition(normalizedInput, normalizedBrand)
}

export async function assignBrandIfKnown(countryCode: countryCodes, source: sources, job?: Job) {
    const context = { scope: "assignBrandIfKnown" } as ContextType

    const brandsMapping = await getBrandsMapping()

    const versionKey = "assignBrandIfKnown"
    let products = await getPharmacyItems(countryCode, source, versionKey, false)
    let counter = 0
    
    for (let product of products) {
        counter++

        if (product.m_id) {
            // Already exists in the mapping table, probably no need to update
            continue
        }

        // Rule 2: Remove noise words from title
        const cleanedTitle = removeNoiseWords(product.title)

        let matchedBrands = []
        for (const brandKey in brandsMapping) {
            const relatedBrands = brandsMapping[brandKey]
            for (const brand of relatedBrands) {
                if (matchedBrands.includes(brand)) {
                    continue
                }
                // Use cleaned title with all validation rules
                const isBrandMatch = checkBrandIsSeparateTerm(cleanedTitle, brand)
                if (isBrandMatch) {
                    matchedBrands.push(brand)
                }
            }
        }
        
        // Rule 5: Prioritize brands by position in title
        if (matchedBrands.length > 1) {
            matchedBrands = prioritizeBrandsByPosition(matchedBrands, cleanedTitle)
        }
        
        // Task 2: Always assign the same canonical brand for the entire group
        // This ensures consistent brand assignment across all products in the same brand family
        const outputBrand = matchedBrands.length 
            ? getCanonicalBrand(matchedBrands, brandsMapping)
            : ''
        
        console.log(`${product.title} -> ${outputBrand}`)

        const sourceId = product.source_id
        const meta = { matchedBrands }
        const brand = matchedBrands.length ? matchedBrands[0] : null

        const key = `${source}_${countryCode}_${sourceId}`
        const uuid = stringToHash(key)

        // Then brand is inserted into product mapping table
    }
}
